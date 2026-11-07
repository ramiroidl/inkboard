import { createHash, randomUUID } from "node:crypto";

import type {
  CustomScreen,
  CustomScreenInput,
  QuietHours,
  RotationSettings,
  ScheduleRule,
  ScheduleRuleInput,
  ScheduleState,
  ScreenId,
  ScreenSummary,
  ScreenWidget,
} from "@inkboard/contracts";
import { Type } from "@sinclair/typebox";
import { asc, eq } from "drizzle-orm";

import type { ArtifactService } from "../artifacts/artifact-service.js";
import type { CalendarService } from "../calendar/calendar-service.js";
import type { InkboardDatabase } from "../db/database.js";
import { customScreens, devices, settings, type ArtifactRecord } from "../db/schema.js";
import type { HomeAssistantStateClient } from "../integrations/home-assistant-states.js";
import type { JsonFetchCache } from "../integrations/http-json.js";
import type { WidgetRegistry } from "../widgets/registry.js";
import { renderScreenSvg } from "../widgets/render.js";
import type { TodoService } from "../todo/todo-service.js";
import type { WidgetServices } from "../widgets/types.js";
import {
  ALL_DAYS,
  isWindowActive,
  localTime,
  parseClock,
  secondsUntilChange,
} from "./schedule-time.js";

export type NavigationDirection = "previous" | "next";

export const ScreenIdSchema = Type.String({ minLength: 1, maxLength: 64 });

/**
 * Request-level shape of a widget. Its settings are validated against the widget plugin's
 * own schema by the registry, so new widgets need no changes here.
 */
export const ScreenWidgetSchema = Type.Object(
  { type: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: true },
);

export const CustomScreenInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 60 }),
    widgets: Type.Array(ScreenWidgetSchema, { maxItems: 12 }),
  },
  { additionalProperties: false },
);

export const RotationSettingsSchema = Type.Object(
  {
    screenIds: Type.Array(ScreenIdSchema, { maxItems: 32 }),
    intervalMinutes: Type.Integer({ minimum: 5, maximum: 1440 }),
  },
  { additionalProperties: false },
);

const ROTATION_KEY = "rotation";
const SCHEDULES_KEY = "schedules";
const QUIET_HOURS_KEY = "quietHours";
const TEST_PATTERN_HIDDEN_KEY = "testPatternHidden";
const CUSTOMIZED_BUILTINS_KEY = "customizedBuiltins";

type CustomizableScreenId = "calendar" | "todo";

function isCustomizable(screenId: string): screenId is CustomizableScreenId {
  return screenId === "calendar" || screenId === "todo";
}

/** Widgets that recreate each customizable built-in screen; defaults fill other settings. */
const BUILTIN_TEMPLATES: Record<
  CustomizableScreenId,
  { name: string; widgets: (Record<string, unknown> & { type: string })[] }
> = {
  calendar: {
    name: "Calendar",
    widgets: [
      { type: "datetime", format: "date" },
      { type: "calendar", maxEvents: 8 },
    ],
  },
  todo: {
    name: "To Do",
    widgets: [
      { type: "heading", text: "To Do", size: "medium" },
      { type: "todo", maxItems: 10 },
    ],
  },
};
const DEFAULT_ROTATION: RotationSettings = { screenIds: [], intervalMinutes: 15 };
const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: "22:00", end: "07:00" };
/** Device refresh cadence outside quiet hours, matching the firmware's sleep default. */
const DEFAULT_REFRESH_SECONDS = 900;
const MIN_REFRESH_SECONDS = 60;
const MAX_REFRESH_SECONDS = 12 * 60 * 60;
/** A button press lets the following image request bypass quiet hours. */
const MANUAL_REQUEST_WINDOW_MS = 2 * 60_000;
/** Wake shortly after a boundary so the device never wakes just before it. */
const BOUNDARY_BUFFER_SECONDS = 5;

const ClockSchema = Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" });

export const ScheduleRuleInputSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ maxLength: 32 })),
    screenId: ScreenIdSchema,
    days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7 }),
    start: ClockSchema,
    end: ClockSchema,
  },
  { additionalProperties: false },
);

export const ScheduleRuleSchema = Type.Object({
  id: Type.String(),
  screenId: ScreenIdSchema,
  days: Type.Array(Type.Integer()),
  start: Type.String(),
  end: Type.String(),
});

export const QuietHoursSchema = Type.Object(
  { enabled: Type.Boolean(), start: ClockSchema, end: ClockSchema },
  { additionalProperties: false },
);

const BUILTIN_SCREENS: Record<"calendar" | "todo" | "orientation", ScreenSummary> = {
  calendar: {
    id: "calendar",
    name: "Calendar",
    description: "Upcoming Home Assistant calendar events",
    kind: "builtin",
  },
  todo: {
    id: "todo",
    name: "To Do",
    description: "Open Microsoft To Do tasks",
    kind: "builtin",
  },
  orientation: {
    id: "orientation",
    name: "Test pattern",
    description: "Orientation and polarity test target",
    kind: "builtin",
  },
};

export class ScreenNotFoundError extends Error {}
export class InvalidRotationError extends Error {}
export class InvalidScheduleError extends Error {}

export class ScreenService {
  private readonly renderCache = new Map<ScreenId, { svgHash: string; artifact: ArtifactRecord }>();

  public constructor(
    private readonly database: InkboardDatabase,
    private readonly calendarService: CalendarService,
    private readonly artifactService: ArtifactService,
    private readonly stateClient: HomeAssistantStateClient | null,
    private readonly timeZone: string,
    private readonly widgetRegistry: WidgetRegistry,
    private readonly jsonCache: JsonFetchCache,
    private readonly now: () => Date = () => new Date(),
    private readonly todoService: TodoService | null = null,
  ) {}

  public listScreens(): ScreenSummary[] {
    const customized = this.customizedBuiltins();
    const custom = this.listCustomScreens().map((screen): ScreenSummary => ({
      id: screen.id,
      name: screen.name,
      description: this.describeWidgets(screen.widgets),
      kind: "custom",
    }));
    const content = [
      ...(this.calendarService.getStatus().configured && customized.calendar === undefined
        ? [{ ...BUILTIN_SCREENS.calendar, customizable: true }]
        : []),
      ...(this.todoService?.isAvailable() === true && customized.todo === undefined
        ? [{ ...BUILTIN_SCREENS.todo, customizable: true }]
        : []),
    ];
    // The test pattern stays as a fallback so a display always has a screen.
    const showTestPattern = !this.isTestPatternHidden() || content.length + custom.length === 0;
    return [...content, ...(showTestPattern ? [BUILTIN_SCREENS.orientation] : []), ...custom];
  }

  /** Built-in screens replaced by an editable copy, limited to copies that still exist. */
  private customizedBuiltins(): Partial<Record<CustomizableScreenId, string>> {
    const stored = this.readSetting<Partial<Record<CustomizableScreenId, string>>>(
      CUSTOMIZED_BUILTINS_KEY,
      {},
    );
    const existing = new Set(this.listCustomScreens().map((screen) => screen.id));
    return Object.fromEntries(
      Object.entries(stored).filter(
        ([, screenId]) => screenId !== undefined && existing.has(screenId),
      ),
    );
  }

  /**
   * Replaces a built-in screen with an editable screen made of widgets, so each part can be
   * configured. Rotation, schedules, and displays showing the built-in switch to the copy.
   * Deleting the copy brings the built-in back.
   */
  public customizeBuiltin(screenId: string): CustomScreen {
    if (!isCustomizable(screenId)) {
      throw new ScreenNotFoundError(`Screen ${screenId} cannot be customized`);
    }
    const existing = this.customizedBuiltins()[screenId];
    if (existing !== undefined) {
      return this.getCustomScreen(existing);
    }
    if (!this.isAvailable(screenId)) {
      throw new ScreenNotFoundError(`Screen ${screenId} is not available`);
    }
    const template = BUILTIN_TEMPLATES[screenId];
    const widgets = template.widgets.map((widget): ScreenWidget => {
      const definition = this.widgetRegistry.get(widget.type);
      return {
        ...(definition === undefined ? {} : structuredClone(definition.defaultConfig)),
        ...widget,
      };
    });
    const copy = this.createCustomScreen({ name: template.name, widgets });
    this.database.raw.transaction(() => {
      this.replaceScreenReferences(screenId, copy.id);
      this.writeSetting(CUSTOMIZED_BUILTINS_KEY, {
        ...this.readSetting<Record<string, string>>(CUSTOMIZED_BUILTINS_KEY, {}),
        [screenId]: copy.id,
      });
    })();
    return copy;
  }

  /** Points rotation, schedules, and displays at another screen. */
  private replaceScreenReferences(from: string, to: string): void {
    const rotation = this.readRotation();
    this.writeRotation({
      ...rotation,
      screenIds: [...new Set(rotation.screenIds.map((id) => (id === from ? to : id)))],
    });
    this.writeSetting(
      SCHEDULES_KEY,
      this.readSchedules().map((rule) =>
        rule.screenId === from ? { ...rule, screenId: to } : rule,
      ),
    );
    this.database.orm
      .update(devices)
      .set({ currentScreenId: to })
      .where(eq(devices.currentScreenId, from))
      .run();
  }

  public isTestPatternHidden(): boolean {
    return this.readSetting(TEST_PATTERN_HIDDEN_KEY, false);
  }

  public setTestPatternHidden(hidden: boolean): void {
    this.writeSetting(TEST_PATTERN_HIDDEN_KEY, hidden);
  }

  private describeWidgets(widgets: ScreenWidget[]): string {
    if (widgets.length === 0) {
      return "Empty custom screen";
    }
    const counts = new Map<string, number>();
    for (const widget of widgets) {
      const name = this.widgetRegistry.get(widget.type)?.name ?? widget.type;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => (count === 1 ? name : `${count}× ${name}`))
      .join(", ");
  }

  public defaultScreenId(): ScreenId {
    return this.listScreens()[0]!.id;
  }

  public isAvailable(screenId: string): boolean {
    return this.listScreens().some((screen) => screen.id === screenId);
  }

  public resolveScreenId(screenId: string | null | undefined): ScreenId {
    return screenId !== null && screenId !== undefined && this.isAvailable(screenId)
      ? screenId
      : this.defaultScreenId();
  }

  public navigate(current: string | null | undefined, direction: NavigationDirection): ScreenId {
    const screens = this.listScreens();
    const currentId = this.resolveScreenId(current);
    const currentIndex = screens.findIndex((screen) => screen.id === currentId);
    const offset = direction === "next" ? 1 : -1;
    return screens[(currentIndex + offset + screens.length) % screens.length]!.id;
  }

  public listCustomScreens(): CustomScreen[] {
    return this.database.orm
      .select()
      .from(customScreens)
      .orderBy(asc(customScreens.createdAt), asc(customScreens.id))
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        widgets: JSON.parse(row.widgetsJson) as ScreenWidget[],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }

  public getCustomScreen(screenId: string): CustomScreen {
    const screen = this.listCustomScreens().find((candidate) => candidate.id === screenId);
    if (screen === undefined) {
      throw new ScreenNotFoundError(`Screen ${screenId} was not found`);
    }
    return screen;
  }

  public createCustomScreen(input: CustomScreenInput): CustomScreen {
    this.widgetRegistry.validateWidgets(input.widgets);
    const now = this.now().toISOString();
    const id = `screen_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.database.orm
      .insert(customScreens)
      .values({
        id,
        name: input.name.trim(),
        widgetsJson: JSON.stringify(input.widgets),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.getCustomScreen(id);
  }

  public updateCustomScreen(screenId: string, input: CustomScreenInput): CustomScreen {
    this.widgetRegistry.validateWidgets(input.widgets);
    const result = this.database.orm
      .update(customScreens)
      .set({
        name: input.name.trim(),
        widgetsJson: JSON.stringify(input.widgets),
        updatedAt: this.now().toISOString(),
      })
      .where(eq(customScreens.id, screenId))
      .run();
    if (result.changes === 0) {
      throw new ScreenNotFoundError(`Screen ${screenId} was not found`);
    }
    this.renderCache.delete(screenId);
    return this.getCustomScreen(screenId);
  }

  public deleteCustomScreen(screenId: string): void {
    // Deleting a customized built-in hands its places back to the built-in screen.
    const builtin = Object.entries(
      this.readSetting<Record<string, string>>(CUSTOMIZED_BUILTINS_KEY, {}),
    ).find(([, copyId]) => copyId === screenId)?.[0];
    this.database.raw.transaction(() => {
      const result = this.database.orm
        .delete(customScreens)
        .where(eq(customScreens.id, screenId))
        .run();
      if (result.changes === 0) {
        throw new ScreenNotFoundError(`Screen ${screenId} was not found`);
      }
      if (builtin !== undefined) {
        const remaining = this.readSetting<Record<string, string>>(CUSTOMIZED_BUILTINS_KEY, {});
        delete remaining[builtin];
        this.writeSetting(CUSTOMIZED_BUILTINS_KEY, remaining);
        this.replaceScreenReferences(screenId, builtin);
        return;
      }
      const rotation = this.readRotation();
      this.writeRotation({
        ...rotation,
        screenIds: rotation.screenIds.filter((id) => id !== screenId),
      });
      this.writeSetting(
        SCHEDULES_KEY,
        this.readSchedules().filter((rule) => rule.screenId !== screenId),
      );
    })();
    this.renderCache.delete(screenId);
  }

  /** Rotation entries for screens that are no longer available are ignored. */
  public getRotation(): RotationSettings {
    const rotation = this.readRotation();
    return {
      ...rotation,
      screenIds: rotation.screenIds.filter((id) => this.isAvailable(id)),
    };
  }

  public setRotation(rotation: RotationSettings): RotationSettings {
    const unavailable = rotation.screenIds.filter((id) => !this.isAvailable(id));
    if (unavailable.length > 0) {
      throw new InvalidRotationError(`Unknown screens: ${unavailable.join(", ")}`);
    }
    if (new Set(rotation.screenIds).size !== rotation.screenIds.length) {
      throw new InvalidRotationError("A screen can appear in the rotation only once");
    }
    this.writeRotation(rotation);
    return this.getRotation();
  }

  /** Schedule rules for screens that are no longer available are ignored. */
  public getSchedules(): ScheduleRule[] {
    return this.readSchedules().filter((rule) => this.isAvailable(rule.screenId));
  }

  /** Rules are evaluated in order; the first active rule wins. */
  public setSchedules(inputs: ScheduleRuleInput[]): ScheduleRule[] {
    const rules = inputs.map((input, index): ScheduleRule => {
      if (!this.isAvailable(input.screenId)) {
        throw new InvalidScheduleError(`Rule ${index + 1}: unknown screen ${input.screenId}`);
      }
      if (input.start === input.end) {
        throw new InvalidScheduleError(`Rule ${index + 1}: start and end must differ`);
      }
      const days = [...new Set(input.days)].sort((left, right) => left - right);
      return {
        id:
          input.id !== undefined && /^rule_[a-f0-9]{8}$/.test(input.id)
            ? input.id
            : `rule_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        screenId: input.screenId,
        days,
        start: input.start,
        end: input.end,
      };
    });
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
      throw new InvalidScheduleError("Rule IDs must be unique");
    }
    this.writeSetting(SCHEDULES_KEY, rules);
    return this.getSchedules();
  }

  public getQuietHours(): QuietHours {
    return this.readSetting(QUIET_HOURS_KEY, DEFAULT_QUIET_HOURS);
  }

  public setQuietHours(quietHours: QuietHours): QuietHours {
    if (quietHours.start === quietHours.end) {
      throw new InvalidScheduleError("Quiet hours start and end must differ");
    }
    this.writeSetting(QUIET_HOURS_KEY, quietHours);
    return this.getQuietHours();
  }

  public getTimeZone(): string {
    return this.timeZone;
  }

  public getScheduleState(): ScheduleState {
    const now = this.now();
    return {
      activeRuleId: this.activeRule(now)?.id ?? null,
      quietHoursActive: this.isQuietAt(now),
    };
  }

  public isQuietHours(): boolean {
    return this.isQuietAt(this.now());
  }

  /** True when the device pressed a button recently, so its next image is not frozen. */
  public hasRecentManualRequest(deviceId: string): boolean {
    const device = this.findDevice(deviceId);
    return (
      device?.manualRequestAt !== null &&
      device?.manualRequestAt !== undefined &&
      this.now().getTime() - Date.parse(device.manualRequestAt) < MANUAL_REQUEST_WINDOW_MS
    );
  }

  /** A manually chosen screen is kept for one rotation interval before schedules resume. */
  public manualHoldUntil(): string {
    return new Date(
      this.now().getTime() + this.getRotation().intervalMinutes * 60_000,
    ).toISOString();
  }

  /**
   * Seconds until the device should check in again: the end of quiet hours while they are
   * active, otherwise the next schedule, quiet-hours, rotation, or manual-hold boundary,
   * capped at the default refresh cadence.
   */
  public nextRefreshSeconds(deviceId: string): number {
    const now = this.now();
    const clamp = (seconds: number) =>
      Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.ceil(seconds)));

    if (this.isQuietAt(now)) {
      const untilEnd = secondsUntilChange(now, 24 * 60, (instant) => this.isQuietAt(instant));
      return clamp((untilEnd ?? DEFAULT_REFRESH_SECONDS) + BOUNDARY_BUFFER_SECONDS);
    }

    const candidates = [DEFAULT_REFRESH_SECONDS];
    const rules = this.getSchedules();
    const boundary = secondsUntilChange(
      now,
      Math.ceil(DEFAULT_REFRESH_SECONDS / 60),
      (instant) => `${this.isQuietAt(instant)}|${this.activeRule(instant, rules)?.id ?? ""}`,
    );
    if (boundary !== null) {
      candidates.push(boundary + BOUNDARY_BUFFER_SECONDS);
    }

    const device = this.findDevice(deviceId);
    if (device?.manualHoldUntil !== null && device?.manualHoldUntil !== undefined) {
      const remaining = (Date.parse(device.manualHoldUntil) - now.getTime()) / 1000;
      if (remaining > 0) {
        candidates.push(remaining + BOUNDARY_BUFFER_SECONDS);
      }
    }
    const rotation = this.getRotation();
    if (rotation.screenIds.length > 0 && device?.screenChangedAt) {
      const due =
        (Date.parse(device.screenChangedAt) + rotation.intervalMinutes * 60_000 - now.getTime()) /
        1000;
      if (due > 0) {
        candidates.push(due + BOUNDARY_BUFFER_SECONDS);
      }
    }
    return clamp(Math.min(...candidates));
  }

  /**
   * Returns the screen a device should display now, in priority order:
   * 1. a screen chosen manually within the hold period;
   * 2. the first active schedule rule (the previous screen is restored when it ends);
   * 3. the rotation, advancing once the current screen has been shown for an interval.
   */
  public currentScreenForDevice(deviceId: string | null): ScreenId {
    if (deviceId === null) {
      return this.defaultScreenId();
    }
    const device = this.findDevice(deviceId);
    if (device === undefined) {
      return this.defaultScreenId();
    }

    const now = this.now();
    const current = this.resolveScreenId(device.currentScreenId);
    if (device.manualHoldUntil !== null && Date.parse(device.manualHoldUntil) > now.getTime()) {
      return current;
    }

    const rule = this.activeRule(now);
    if (rule !== undefined) {
      if (device.scheduleRuleId !== rule.id || current !== rule.screenId) {
        this.updateDevice(deviceId, {
          currentScreenId: rule.screenId,
          ...(current !== rule.screenId ? { screenChangedAt: now.toISOString() } : {}),
          scheduleRuleId: rule.id,
          preScheduleScreenId:
            device.scheduleRuleId === null ? current : device.preScheduleScreenId,
        });
      }
      return rule.screenId;
    }

    if (device.scheduleRuleId !== null) {
      const restored = this.resolveScreenId(device.preScheduleScreenId);
      this.updateDevice(deviceId, {
        currentScreenId: restored,
        screenChangedAt: now.toISOString(),
        scheduleRuleId: null,
        preScheduleScreenId: null,
      });
      return restored;
    }

    const rotation = this.getRotation();
    if (rotation.screenIds.length === 0) {
      return current;
    }
    const changedAt = device.screenChangedAt === null ? 0 : Date.parse(device.screenChangedAt);
    if (now.getTime() - changedAt < rotation.intervalMinutes * 60_000) {
      return current;
    }

    const index = rotation.screenIds.indexOf(current);
    const next = rotation.screenIds[(index + 1) % rotation.screenIds.length]!;
    this.updateDevice(deviceId, { currentScreenId: next, screenChangedAt: now.toISOString() });
    return next;
  }

  /** Selects a screen from the admin UI and holds it like a button press. */
  public setDeviceScreen(deviceId: string, screenId: ScreenId): boolean {
    const now = this.now().toISOString();
    return this.updateDevice(deviceId, {
      currentScreenId: screenId,
      screenChangedAt: now,
      manualHoldUntil: this.manualHoldUntil(),
    });
  }

  private updateDevice(deviceId: string, values: Partial<typeof devices.$inferInsert>): boolean {
    const result = this.database.orm
      .update(devices)
      .set({ ...values, updatedAt: this.now().toISOString() })
      .where(eq(devices.id, deviceId))
      .run();
    return result.changes > 0;
  }

  private findDevice(deviceId: string) {
    return this.database.orm.select().from(devices).where(eq(devices.id, deviceId)).get();
  }

  private activeRule(now: Date, rules = this.getSchedules()): ScheduleRule | undefined {
    const time = localTime(now, this.timeZone);
    return rules.find((rule) => isWindowActive(rule, time));
  }

  private isQuietAt(instant: Date): boolean {
    const quiet = this.getQuietHours();
    return (
      quiet.enabled &&
      isWindowActive({ days: ALL_DAYS, ...quiet }, localTime(instant, this.timeZone))
    );
  }

  private readSchedules(): ScheduleRule[] {
    return this.readSetting<ScheduleRule[]>(SCHEDULES_KEY, []).filter((rule) => {
      try {
        parseClock(rule.start);
        parseClock(rule.end);
        return true;
      } catch {
        return false;
      }
    });
  }

  private readSetting<T>(key: string, fallback: T): T {
    const row = this.database.orm.select().from(settings).where(eq(settings.key, key)).get();
    return row === undefined ? fallback : (JSON.parse(row.valueJson) as T);
  }

  private writeSetting(key: string, value: unknown): void {
    const now = this.now().toISOString();
    const valueJson = JSON.stringify(value);
    this.database.orm
      .insert(settings)
      .values({ key, valueJson, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: now } })
      .run();
  }

  public async getArtifact(screenId: ScreenId): Promise<ArtifactRecord> {
    if (screenId === "calendar") {
      return this.calendarService.getCurrentArtifact();
    }
    if (screenId === "todo" && this.todoService !== null) {
      return this.todoService.getCurrentArtifact();
    }
    if (screenId === "orientation") {
      return this.artifactService.getOrientationArtifact();
    }

    const screen = this.getCustomScreen(screenId);
    const svg = await this.renderCustomSvg(screen);
    const svgHash = createHash("sha256").update(svg).digest("hex");
    const cached = this.renderCache.get(screenId);
    if (cached?.svgHash === svgHash) {
      return cached.artifact;
    }
    const bmp = await this.artifactService.rasterize(svg, `screen ${screenId}`);
    const artifact = await this.artifactService.persistScreenArtifact(`screen:${screenId}`, bmp);
    this.renderCache.set(screenId, { svgHash, artifact });
    return artifact;
  }

  public async renderPreview(input: CustomScreenInput): Promise<Buffer> {
    this.widgetRegistry.validateWidgets(input.widgets);
    return this.artifactService.rasterize(await this.renderCustomSvg(input), "screen preview");
  }

  /** The services widget plugins may use while loading data. */
  private widgetServices(): WidgetServices {
    const stateClient = this.stateClient;
    return {
      timeZone: this.timeZone,
      now: this.now(),
      homeAssistant: {
        configured: stateClient !== null,
        getState: async (entityId) =>
          stateClient === null ? null : stateClient.getState(entityId),
        getLocation: async () => (stateClient === null ? null : stateClient.getLocation()),
      },
      calendar: {
        configured: this.calendarService.getStatus().homeAssistantConfigured,
        getEvents: (entityIds) => this.calendarService.getEvents(entityIds),
        getEventsBetween: (start, end, entityIds) =>
          this.calendarService.getEventsBetween(start, end, entityIds),
      },
      todo: {
        configured: this.todoService?.isConnected() === true,
        getTasks: async (listIds) =>
          this.todoService === null ? [] : this.todoService.getTasks(listIds),
      },
      fetchJson: (url, options) => this.jsonCache.getJson(url, options?.ttlSeconds),
    };
  }

  private async renderCustomSvg(screen: CustomScreenInput): Promise<string> {
    return renderScreenSvg(screen, this.widgetRegistry, this.widgetServices());
  }

  private readRotation(): RotationSettings {
    return this.readSetting(ROTATION_KEY, DEFAULT_ROTATION);
  }

  private writeRotation(rotation: RotationSettings): void {
    this.writeSetting(ROTATION_KEY, rotation);
  }
}
