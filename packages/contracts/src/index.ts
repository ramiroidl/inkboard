export const SEEED_EE04_DISPLAY_PROFILE = {
  id: "seeed-ee04-800x480-mono",
  width: 800,
  height: 480,
  bitsPerPixel: 1,
  expectedBmpBytes: 48_062,
} as const;

export interface HealthResponse {
  status: "ok";
  service: "inkboard-controller";
  version: string;
}

export interface ReadinessResponse extends HealthResponse {
  database: "ready";
  artifactStore: "ready";
}

export interface AdminStatusResponse {
  service: HealthResponse;
  displayProfile: typeof SEEED_EE04_DISPLAY_PROFILE;
  calendar: CalendarStatus;
  app: AppRuntimeStatus;
}

export interface AppRuntimeStatus {
  mode: "standalone" | "home_assistant";
  /** Port of the device-only listener, when one is running. */
  devicePort: number | null;
  /** Shown only inside the Home Assistant App, where the admin UI requires login. */
  deviceApiToken: string | null;
}

export interface EntitySummary {
  entityId: string;
  name: string;
  domain: string;
}

export interface AdminEntitiesResponse {
  entities: EntitySummary[];
  error: string | null;
}

export type CalendarState = "disabled" | "ready" | "degraded";

export interface CalendarSourceStatus {
  entityId: string;
  name: string;
  eventCount: number;
  lastSuccessfulRefreshAt: string | null;
  lastError: string | null;
}

export interface CalendarStatus {
  /** True when Home Assistant is connected and at least one calendar is selected. */
  configured: boolean;
  /** True when a Home Assistant URL and token are configured. */
  homeAssistantConfigured: boolean;
  state: CalendarState;
  entityIds: string[];
  calendars: CalendarSourceStatus[];
  timeZone: string | null;
  lookAheadDays: number | null;
  lastAttemptAt: string | null;
  lastSuccessfulRefreshAt: string | null;
  lastError: string | null;
  eventCount: number;
}

export interface AvailableCalendar {
  entityId: string;
  name: string;
}

export interface AdminCalendarsResponse {
  /** Calendars Home Assistant reports; empty with `discoveryError` when unavailable. */
  available: AvailableCalendar[];
  selected: string[];
  discoveryError: string | null;
}

export interface SetCalendarsRequest {
  entityIds: string[];
}

export type TodoImportance = "low" | "normal" | "high";

/** An incomplete Microsoft To Do task, normalized for rendering. */
export interface TodoTask {
  id: string;
  title: string;
  listId: string;
  listName: string;
  /** Due date as `YYYY-MM-DD`, or null when the task has no due date. */
  dueDate: string | null;
  importance: TodoImportance;
  recurring: boolean;
  createdAt: string | null;
}

export type MicrosoftTodoState =
  "not_configured" | "signed_out" | "pending" | "signed_in" | "reauth_required";

export interface MicrosoftTodoListStatus {
  id: string;
  name: string;
  taskCount: number;
  lastSuccessfulRefreshAt: string | null;
  lastError: string | null;
}

export interface MicrosoftTodoStatus {
  state: MicrosoftTodoState;
  /** Application (client) ID of the Microsoft Entra app registration. Not a secret. */
  clientId: string | null;
  tenant: string;
  /** Signed-in Microsoft account, for display. */
  account: string | null;
  /** The code to enter while a device sign-in is waiting. */
  signIn: { userCode: string; verificationUri: string; expiresAt: string } | null;
  selectedListIds: string[];
  lists: MicrosoftTodoListStatus[];
  taskCount: number;
  lastSuccessfulRefreshAt: string | null;
  lastError: string | null;
}

export interface TodoListSummary {
  id: string;
  name: string;
}

export interface AdminTodoListsResponse {
  available: TodoListSummary[];
  selected: string[];
  error: string | null;
}

export const DEVICE_WAKE_REASONS = [
  "cold_boot",
  "timer",
  "key1",
  "key2",
  "key3",
  "unknown",
] as const;

export const DEVICE_BUTTON_EVENTS = ["none", "previous", "refresh", "next"] as const;

export const DEVICE_DISPLAY_RESULTS = [
  "boot",
  "displayed",
  "not_modified",
  "download_failed",
  "button",
] as const;

export type DeviceWakeReason = (typeof DEVICE_WAKE_REASONS)[number];
export type DeviceButtonEvent = (typeof DEVICE_BUTTON_EVENTS)[number];
export type DeviceDisplayResult = (typeof DEVICE_DISPLAY_RESULTS)[number];

export interface DeviceCheckInRequest {
  deviceId: string;
  firmwareVersion: string;
  model: typeof SEEED_EE04_DISPLAY_PROFILE.id;
  width: typeof SEEED_EE04_DISPLAY_PROFILE.width;
  height: typeof SEEED_EE04_DISPLAY_PROFILE.height;
  screenRevision?: string;
  wakeReason: DeviceWakeReason;
  wifiRssi?: number;
  batteryVoltage?: number;
  buttonEvent: DeviceButtonEvent;
  displayResult: DeviceDisplayResult;
}

export interface DeviceCheckInResponse {
  status: "ok";
  serverTime: string;
  nextRefreshSeconds: number;
  screenRevision: string;
  screenId: ScreenId;
}

export interface AdminDevice {
  id: string;
  model: string;
  firmwareVersion: string;
  width: number;
  height: number;
  lastSeenAt: string;
  lastScreenRevision: string | null;
  lastWakeReason: string;
  lastWifiRssi: number | null;
  lastBatteryVoltage: number | null;
  lastButtonEvent: string;
  lastDisplayResult: string;
  currentScreenId: ScreenId;
  /** The controller flips this display's images, for panels that show white on black. */
  invertColors: boolean;
  /** Draw the battery level in the lower-right corner of this display's images. */
  showBattery: boolean;
}

export interface AdminDevicesResponse {
  devices: AdminDevice[];
}

/** Persisted screen IDs, or `orientation` for the diagnostic test pattern. */
export type ScreenId = string;

export type ScreenKind = "diagnostic" | "custom";

export interface ScreenSummary {
  id: ScreenId;
  name: string;
  description: string;
  kind: ScreenKind;
}

export interface RotationSettings {
  screenIds: ScreenId[];
  intervalMinutes: number;
}

/** Days use 0 = Sunday through 6 = Saturday. Times are local `HH:MM` (24-hour). */
export interface ScheduleRule {
  id: string;
  screenId: ScreenId;
  days: number[];
  start: string;
  end: string;
}

export type ScheduleRuleInput = Omit<ScheduleRule, "id"> & { id?: string };

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface ScheduleState {
  activeRuleId: string | null;
  quietHoursActive: boolean;
}

export interface AdminScreensResponse {
  defaultScreenId: ScreenId;
  screens: ScreenSummary[];
  rotation: RotationSettings;
  schedules: ScheduleRule[];
  quietHours: QuietHours;
  scheduleState: ScheduleState;
  timeZone: string;
  /** The test pattern is listed only when it is not hidden or no other screen exists. */
  testPatternHidden: boolean;
}

export interface SetDeviceScreenRequest {
  screenId: ScreenId;
}

/**
 * A widget placed on a custom screen. `type` selects the widget plugin; the remaining
 * properties are that plugin's settings, validated against its `configSchema`.
 */
export interface ScreenWidget {
  type: string;
  [setting: string]: unknown;
}

/** The subset of JSON Schema that widget settings use and the editor understands. */
export interface WidgetSettingSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, WidgetSettingSchema>;
  required?: string[];
  anyOf?: WidgetSettingSchema[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  examples?: unknown[];
  /** Schema of each element when `type` is `array`. */
  items?: WidgetSettingSchema;
  maxItems?: number;
  uniqueItems?: boolean;
  /** Editor hints for multi-line text, a date, or an array of CSV records. */
  "x-input"?: "textarea" | "date" | "csv";
  /** Applied only when adding a new widget, using the controller's time zone. */
  "x-default"?: "today";
  /**
   * Editor hint: suggest Home Assistant entity IDs, optionally limited to these domains. On an
   * array of strings, the editor shows a checkbox per matching entity.
   */
  "x-suggest"?: "entity" | "todo-list";
  "x-domains"?: string[];
}

export interface WidgetDescriptor {
  type: string;
  name: string;
  description: string;
  /** Consecutive widgets of this type share a row of up to this many cells. */
  maxPerRow: number;
  defaultConfig: Record<string, unknown>;
  configSchema: WidgetSettingSchema;
}

export interface AdminWidgetsResponse {
  widgets: WidgetDescriptor[];
}

export interface CustomScreenInput {
  name: string;
  widgets: ScreenWidget[];
}

export interface CustomScreen extends CustomScreenInput {
  id: ScreenId;
  createdAt: string;
  updatedAt: string;
}

/** Screens and display settings exported from one controller to import into another. */
export interface InkboardBackup {
  format: "inkboard-backup";
  version: 1 | 2;
  exportedAt: string;
  screens: { id: string; name: string; widgets: ScreenWidget[] }[];
  rotation: RotationSettings;
  schedules: { screenId: ScreenId; days: number[]; start: string; end: string }[];
  quietHours: QuietHours;
  testPatternHidden: boolean;
  /** Legacy selections for version 1 imports; empty in version 2 exports. */
  calendars: string[];
  /** Legacy selections for version 1 imports; empty in version 2 exports. */
  todoLists: string[];
}

export interface InkboardBackupImportResult {
  screensCreated: number;
  /** Screens that already existed with the same name and widgets. */
  screensReused: number;
  /** Settings that could not be applied, such as screens unavailable here. */
  warnings: string[];
}

/** Typical single-cell lithium battery voltage under light load, from empty to full. */
const BATTERY_CURVE: readonly (readonly [number, number])[] = [
  [3.3, 0],
  [3.5, 5],
  [3.6, 10],
  [3.65, 20],
  [3.7, 30],
  [3.75, 40],
  [3.8, 50],
  [3.85, 60],
  [3.95, 70],
  [4.0, 80],
  [4.1, 90],
  [4.2, 100],
];

/** Estimated charge, 0–100, for a battery voltage; null when the voltage is unknown. */
export function batteryPercent(voltage: number | null | undefined): number | null {
  if (voltage === null || voltage === undefined || !Number.isFinite(voltage)) {
    return null;
  }
  const first = BATTERY_CURVE[0]!;
  const last = BATTERY_CURVE.at(-1)!;
  if (voltage <= first[0]) {
    return 0;
  }
  if (voltage >= last[0]) {
    return 100;
  }
  for (let index = 1; index < BATTERY_CURVE.length; index += 1) {
    const [upperVolts, upperPercent] = BATTERY_CURVE[index]!;
    const [lowerVolts, lowerPercent] = BATTERY_CURVE[index - 1]!;
    if (voltage <= upperVolts) {
      const ratio = (voltage - lowerVolts) / (upperVolts - lowerVolts);
      return Math.round(lowerPercent + ratio * (upperPercent - lowerPercent));
    }
  }
  return 100;
}
