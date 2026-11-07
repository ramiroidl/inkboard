import type {
  AdminCalendarsResponse,
  CalendarSourceStatus,
  CalendarStatus,
} from "@inkboard/contracts";
import { eq } from "drizzle-orm";

import type { ArtifactService } from "../artifacts/artifact-service.js";
import { CALENDAR_ENTITY_PATTERN, type ControllerConfig } from "../config.js";
import type { InkboardDatabase } from "../db/database.js";
import { settings, type ArtifactRecord } from "../db/schema.js";
import {
  eventSortTime,
  HomeAssistantCalendarClient,
  type CalendarEvent,
} from "../integrations/home-assistant-calendar.js";

type FetchImplementation = typeof fetch;

const SELECTION_KEY = "calendarSelection";
const SNAPSHOT_KEY_PREFIX = "calendarSnapshot:";
export const MAX_SELECTED_CALENDARS = 10;
const MAX_CACHED_RANGES = 20;

/** The last successful fetch of one calendar, persisted so restarts keep the agenda. */
interface CalendarSnapshot {
  name: string;
  events: CalendarEvent[];
  fetchedAt: string;
}

interface CalendarSource {
  snapshot: CalendarSnapshot | null;
  lastError: string | null;
}

export class InvalidCalendarSelectionError extends Error {}

/** Same title and time in two calendars, such as a shared event, is shown once. */
export function mergeCalendarEvents(lists: CalendarEvent[][]): CalendarEvent[] {
  const seen = new Set<string>();
  const merged: CalendarEvent[] = [];
  for (const event of lists.flat()) {
    const key = `${event.title}\u0000${event.start}\u0000${event.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  return merged.sort(
    (left, right) =>
      eventSortTime(left) - eventSortTime(right) || left.title.localeCompare(right.title),
  );
}

export class CalendarService {
  private readonly client: HomeAssistantCalendarClient | null;
  private readonly sources = new Map<string, CalendarSource>();
  private readonly names = new Map<string, string>();
  private selection: string[] = [];
  private refreshPromise: Promise<void> | null = null;
  private lastAttemptAt: string | null = null;
  private lastSuccessfulRefreshAt: string | null = null;
  /** Fetch times and in-flight fetches of calendars used only by widgets. */
  private readonly extraAttempts = new Map<string, number>();
  private readonly extraRefreshes = new Map<string, Promise<void>>();
  /** Events for date ranges requested by widgets, such as a whole month. */
  private readonly rangeCache = new Map<string, { events: CalendarEvent[]; fetchedAt: number }>();
  public constructor(
    private readonly config: ControllerConfig,
    private readonly artifactService: ArtifactService,
    private readonly database: InkboardDatabase,
    fetchImplementation: FetchImplementation = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly onRefreshError: (error: Error) => void = () => undefined,
  ) {
    this.client =
      config.homeAssistant === null
        ? null
        : new HomeAssistantCalendarClient(config.homeAssistant, fetchImplementation);
  }

  public async initialize(): Promise<void> {
    if (this.client === null) {
      return;
    }
    const saved = this.readSetting<{ entityIds: string[] }>(SELECTION_KEY);
    this.selection = (saved?.entityIds ?? this.config.homeAssistant!.calendarEntities).filter(
      (entityId) => CALENDAR_ENTITY_PATTERN.test(entityId),
    );
    for (const entityId of this.selection) {
      this.sources.set(entityId, { snapshot: this.readSnapshot(entityId), lastError: null });
    }
    if (this.selection.length > 0) {
      await this.refreshIfDue();
    }
  }

  public getStatus(): CalendarStatus {
    const homeAssistant = this.config.homeAssistant;
    const configured = this.client !== null && this.selection.length > 0;
    const calendars = this.selection.map((entityId): CalendarSourceStatus => {
      const source = this.sources.get(entityId);
      return {
        entityId,
        name: this.nameOf(entityId),
        eventCount: source?.snapshot?.events.length ?? 0,
        lastSuccessfulRefreshAt: source?.snapshot?.fetchedAt ?? null,
        lastError: source?.lastError ?? null,
      };
    });
    const errors = calendars.filter((calendar) => calendar.lastError !== null);
    return {
      configured,
      homeAssistantConfigured: this.client !== null,
      state: !configured
        ? "disabled"
        : errors.length > 0 || this.lastAttemptAt === null
          ? "degraded"
          : "ready",
      entityIds: [...this.selection],
      calendars,
      timeZone: homeAssistant?.timeZone ?? null,
      lookAheadDays: homeAssistant?.lookAheadDays ?? null,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessfulRefreshAt: this.lastSuccessfulRefreshAt,
      lastError:
        errors.length === 0
          ? null
          : calendars.length === 1
            ? errors[0]!.lastError
            : errors.map((calendar) => `${calendar.name}: ${calendar.lastError}`).join("; "),
      eventCount: this.mergedEvents().length,
    };
  }

  /** Calendars Home Assistant offers, for the selection UI. */
  public async listCalendars(): Promise<AdminCalendarsResponse> {
    if (this.client === null) {
      return {
        available: [],
        selected: [],
        discoveryError: "Home Assistant is not configured",
      };
    }
    try {
      const available = await this.client.listCalendars();
      for (const calendar of available) {
        this.names.set(calendar.entityId, calendar.name);
      }
      return { available, selected: [...this.selection], discoveryError: null };
    } catch (error: unknown) {
      return {
        available: [],
        selected: [...this.selection],
        discoveryError: error instanceof Error ? error.message : "Unable to list calendars",
      };
    }
  }

  /** Saves the selected calendars and refreshes them immediately. */
  public async setSelection(entityIds: string[]): Promise<CalendarStatus> {
    if (this.client === null) {
      throw new InvalidCalendarSelectionError("Home Assistant is not configured");
    }
    const unique = [...new Set(entityIds)];
    const invalid = unique.filter((entityId) => !CALENDAR_ENTITY_PATTERN.test(entityId));
    if (invalid.length > 0) {
      throw new InvalidCalendarSelectionError(`Not calendar entities: ${invalid.join(", ")}`);
    }
    if (unique.length > MAX_SELECTED_CALENDARS) {
      throw new InvalidCalendarSelectionError(`Select at most ${MAX_SELECTED_CALENDARS} calendars`);
    }

    if (this.refreshPromise !== null) {
      await this.refreshPromise;
    }
    this.selection = unique;
    this.writeSetting(SELECTION_KEY, { entityIds: unique });
    for (const entityId of unique) {
      if (!this.sources.has(entityId)) {
        this.sources.set(entityId, { snapshot: this.readSnapshot(entityId), lastError: null });
      }
    }
    this.lastAttemptAt = null;
    if (unique.length > 0) {
      await this.refreshIfDue();
    }
    return this.getStatus();
  }

  /**
   * Merged upcoming events. Without `entityIds`, the calendars selected on the admin page are
   * used; otherwise the given calendars, which widgets may choose independently.
   */
  public async getEvents(entityIds?: string[]): Promise<CalendarEvent[]> {
    if (this.client === null) {
      return [];
    }
    const requested = [...new Set(entityIds ?? [])]
      .filter((entityId) => CALENDAR_ENTITY_PATTERN.test(entityId))
      .slice(0, MAX_SELECTED_CALENDARS);
    if (requested.length === 0) {
      if (this.selection.length === 0) {
        return [];
      }
      await this.refreshIfDue();
      return this.mergedEvents();
    }

    if (requested.some((entityId) => this.selection.includes(entityId))) {
      await this.refreshIfDue();
    }
    const now = this.now();
    await Promise.all(
      requested
        .filter((entityId) => !this.selection.includes(entityId))
        .map((entityId) => this.refreshExtraIfDue(entityId, now)),
    );
    const missing = requested.filter((entityId) => !this.sources.get(entityId)?.snapshot);
    if (missing.length === requested.length) {
      const errors = missing.map((entityId) => this.sources.get(entityId)?.lastError);
      throw new Error(errors.find((error) => error) ?? "Calendar events are unavailable");
    }
    return mergeCalendarEvents(
      requested.map((entityId) => this.sources.get(entityId)?.snapshot?.events ?? []),
    );
  }

  /** Fetches a calendar that only widgets use, at most once per refresh interval. */
  private async refreshExtraIfDue(entityId: string, now: Date): Promise<void> {
    const client = this.client;
    const homeAssistant = this.config.homeAssistant;
    if (client === null || homeAssistant === null) {
      return;
    }
    const pending = this.extraRefreshes.get(entityId);
    if (pending !== undefined) {
      return pending;
    }
    const lastAttempt = this.extraAttempts.get(entityId);
    if (
      lastAttempt !== undefined &&
      now.getTime() - lastAttempt < homeAssistant.refreshIntervalSeconds * 1000
    ) {
      return;
    }
    const run = (async () => {
      this.extraAttempts.set(entityId, now.getTime());
      const source = this.sources.get(entityId) ?? {
        snapshot: this.readSnapshot(entityId),
        lastError: null,
      };
      this.sources.set(entityId, source);
      if (!this.names.has(entityId)) {
        try {
          for (const calendar of await client.listCalendars()) {
            this.names.set(calendar.entityId, calendar.name);
          }
        } catch {
          // Names are cosmetic; the event request reports connection problems.
        }
      }
      try {
        const name = this.nameOf(entityId);
        const events = (await client.getEvents(entityId, now)).map((event) => ({
          ...event,
          calendarName: name,
        }));
        source.snapshot = { name, events, fetchedAt: now.toISOString() };
        source.lastError = null;
        this.writeSetting(`${SNAPSHOT_KEY_PREFIX}${entityId}`, source.snapshot);
      } catch (error: unknown) {
        source.lastError = error instanceof Error ? error.message : String(error);
        this.onRefreshError(new Error(`${this.nameOf(entityId)}: ${source.lastError}`));
      }
    })().finally(() => {
      this.extraRefreshes.delete(entityId);
    });
    this.extraRefreshes.set(entityId, run);
    return run;
  }

  /**
   * Events from `start` to `end`, such as a whole month including past days. Without
   * `entityIds`, the calendars selected on the admin page are used. Each range is fetched at
   * most once per refresh interval; when Home Assistant is unavailable, the last events
   * fetched for the range are returned.
   */
  public async getEventsBetween(
    start: Date,
    end: Date,
    entityIds?: string[],
  ): Promise<CalendarEvent[]> {
    const client = this.client;
    const homeAssistant = this.config.homeAssistant;
    if (client === null || homeAssistant === null) {
      return [];
    }
    const requested = [...new Set(entityIds ?? [])]
      .filter((entityId) => CALENDAR_ENTITY_PATTERN.test(entityId))
      .slice(0, MAX_SELECTED_CALENDARS);
    const calendars = requested.length > 0 ? requested : [...this.selection];
    if (calendars.length === 0 || !(end.getTime() > start.getTime())) {
      return [];
    }
    const key = `${calendars.join(",")}|${start.toISOString()}|${end.toISOString()}`;
    const now = this.now().getTime();
    const cached = this.rangeCache.get(key);
    if (
      cached !== undefined &&
      now - cached.fetchedAt < homeAssistant.refreshIntervalSeconds * 1000
    ) {
      return cached.events;
    }

    if (calendars.some((entityId) => !this.names.has(entityId))) {
      try {
        for (const calendar of await client.listCalendars()) {
          this.names.set(calendar.entityId, calendar.name);
        }
      } catch {
        // Names are cosmetic; the event requests below report connection problems.
      }
    }
    const results = await Promise.allSettled(
      calendars.map(async (entityId) => {
        const name = this.nameOf(entityId);
        return (await client.getEventsBetween(entityId, start, end)).map((event) => ({
          ...event,
          calendarName: name,
        }));
      }),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length === results.length) {
      const reason = (failed[0] as PromiseRejectedResult).reason as unknown;
      this.onRefreshError(reason instanceof Error ? reason : new Error(String(reason)));
      if (cached !== undefined) {
        // Retry after the next interval instead of on every render.
        this.rangeCache.set(key, { events: cached.events, fetchedAt: now });
        return cached.events;
      }
      throw reason instanceof Error ? reason : new Error("Calendar events are unavailable");
    }
    // A calendar that failed keeps its previous events for this range.
    const events = mergeCalendarEvents(
      results.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : (cached?.events.filter(
              (event) => event.calendarName === this.nameOf(calendars[index]!),
            ) ?? []),
      ),
    );
    this.rangeCache.delete(key);
    this.rangeCache.set(key, { events, fetchedAt: now });
    while (this.rangeCache.size > MAX_CACHED_RANGES) {
      this.rangeCache.delete(this.rangeCache.keys().next().value!);
    }
    return events;
  }

  public async getCurrentArtifact(): Promise<ArtifactRecord> {
    if (this.client === null || this.selection.length === 0) {
      return this.artifactService.getOrientationArtifact();
    }
    await this.refreshIfDue();
    return (
      (await this.artifactService.getCalendarArtifact()) ??
      this.artifactService.getOrientationArtifact()
    );
  }

  private mergedEvents(): CalendarEvent[] {
    return mergeCalendarEvents(
      this.selection.map((entityId) => this.sources.get(entityId)?.snapshot?.events ?? []),
    );
  }

  private nameOf(entityId: string): string {
    return this.names.get(entityId) ?? this.sources.get(entityId)?.snapshot?.name ?? entityId;
  }

  private isRefreshDue(now: Date): boolean {
    if (this.lastAttemptAt === null || this.config.homeAssistant === null) {
      return true;
    }
    const elapsed = now.getTime() - Date.parse(this.lastAttemptAt);
    return elapsed >= this.config.homeAssistant.refreshIntervalSeconds * 1000;
  }

  private async refreshIfDue(): Promise<void> {
    const now = this.now();
    if (!this.isRefreshDue(now)) {
      return;
    }
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.refresh(now).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refresh(now: Date): Promise<void> {
    const client = this.client;
    const homeAssistant = this.config.homeAssistant;
    if (client === null || homeAssistant === null) {
      return;
    }
    this.lastAttemptAt = now.toISOString();
    const selection = [...this.selection];

    if (selection.some((entityId) => !this.names.has(entityId))) {
      try {
        for (const calendar of await client.listCalendars()) {
          this.names.set(calendar.entityId, calendar.name);
        }
      } catch {
        // Names are cosmetic; the event requests below report connection problems.
      }
    }

    const results = await Promise.all(
      selection.map(async (entityId) => {
        const source = this.sources.get(entityId) ?? { snapshot: null, lastError: null };
        this.sources.set(entityId, source);
        try {
          const name = this.nameOf(entityId);
          const events = (await client.getEvents(entityId, now)).map((event) => ({
            ...event,
            calendarName: name,
          }));
          source.snapshot = { name, events, fetchedAt: now.toISOString() };
          source.lastError = null;
          this.writeSetting(`${SNAPSHOT_KEY_PREFIX}${entityId}`, source.snapshot);
          return true;
        } catch (error: unknown) {
          const normalized =
            error instanceof Error ? error : new Error("Unknown Home Assistant calendar error");
          source.lastError = normalized.message;
          this.onRefreshError(new Error(`${this.nameOf(entityId)}: ${normalized.message}`));
          return false;
        }
      }),
    );

    if (results.every(Boolean)) {
      this.lastSuccessfulRefreshAt = now.toISOString();
    }
    // Render with the last good events of any calendar that failed, so a partial or full
    // outage keeps the agenda; with no events ever fetched, keep the previous image.
    if (selection.some((entityId) => this.sources.get(entityId)?.snapshot)) {
      try {
        await this.artifactService.renderCalendarArtifact(this.mergedEvents(), {
          calendarNames: selection.map((entityId) => this.nameOf(entityId)),
          timeZone: homeAssistant.timeZone,
          lookAheadDays: homeAssistant.lookAheadDays,
          now,
        });
      } catch (error: unknown) {
        this.onRefreshError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private readSnapshot(entityId: string): CalendarSnapshot | null {
    const snapshot = this.readSetting<CalendarSnapshot>(`${SNAPSHOT_KEY_PREFIX}${entityId}`);
    return snapshot !== undefined &&
      typeof snapshot.name === "string" &&
      Array.isArray(snapshot.events) &&
      typeof snapshot.fetchedAt === "string"
      ? snapshot
      : null;
  }

  private readSetting<T>(key: string): T | undefined {
    const row = this.database.orm.select().from(settings).where(eq(settings.key, key)).get();
    if (row === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return undefined;
    }
  }

  private writeSetting(key: string, value: unknown): void {
    const updatedAt = this.now().toISOString();
    const valueJson = JSON.stringify(value);
    this.database.orm
      .insert(settings)
      .values({ key, valueJson, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt } })
      .run();
  }
}
