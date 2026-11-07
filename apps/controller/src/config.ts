import { resolve } from "node:path";

export interface ControllerConfig {
  host: string;
  port: number;
  deviceApiToken: string;
  dataDirectory: string;
  artifactDirectory: string;
  databasePath: string;
  migrationDirectory: string;
  webRoot: string;
  enableDevelopmentRoutes: boolean;
  logLevel: string;
  /** `home_assistant` when running as a Home Assistant App. */
  appMode: "standalone" | "home_assistant";
  /** Separate listener that serves only device and health endpoints, when set. */
  devicePort: number | null;
  /** When set, the main listener serves admin requests only from these addresses. */
  adminAllowedAddresses: string[] | null;
  timeZone: string;
  homeAssistant: HomeAssistantConfig | null;
  microsoftTodo: MicrosoftTodoConfig;
  /** Optional 32-byte key (hex or base64) for secrets at rest; generated when unset. */
  secretKey: string | undefined;
}

export interface MicrosoftTodoConfig {
  /**
   * Default Application (client) ID of the Microsoft Entra app registration. It can also be
   * set on the admin page, which takes precedence.
   */
  clientId: string | null;
  /** `common`, `consumers`, `organizations`, or a tenant ID. */
  tenant: string;
  refreshIntervalSeconds: number;
}

export const MICROSOFT_CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MICROSOFT_TENANT_PATTERN = /^(common|consumers|organizations|[0-9a-z.-]{3,128})$/i;

export interface HomeAssistantConfig {
  baseUrl: string;
  token: string;
  /**
   * Initial calendar selection from INKBOARD_HOME_ASSISTANT_CALENDAR. Once calendars are
   * chosen in the admin UI, the saved selection takes precedence.
   */
  calendarEntities: string[];
  timeZone: string;
  lookAheadDays: number;
  refreshIntervalSeconds: number;
}

export const CALENDAR_ENTITY_PATTERN = /^calendar\.[a-z0-9_]+$/;

function parsePort(value: string | undefined, name = "INKBOARD_PORT"): number {
  if (value === undefined) {
    return 8099;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return port;
}

function parseAddressList(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return value
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error('Boolean configuration values must be either "true" or "false"');
}

function parseDeviceApiToken(value: string | undefined, environment: NodeJS.ProcessEnv): string {
  if (value === undefined) {
    if (environment.NODE_ENV === "production") {
      throw new Error("INKBOARD_DEVICE_API_TOKEN is required in production");
    }
    return "inkboard-development-token-change-me";
  }
  if (value.length < 32) {
    throw new Error("INKBOARD_DEVICE_API_TOKEN must contain at least 32 characters");
  }
  return value;
}

function parseInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function parseTimeZone(environment: NodeJS.ProcessEnv): string {
  const timeZone = environment.INKBOARD_TIME_ZONE ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`INKBOARD_TIME_ZONE is not a valid IANA time zone: ${timeZone}`);
  }
  return timeZone;
}

function parseHomeAssistantConfig(environment: NodeJS.ProcessEnv): HomeAssistantConfig | null {
  const baseUrlValue = environment.INKBOARD_HOME_ASSISTANT_URL;
  const token = environment.INKBOARD_HOME_ASSISTANT_TOKEN;
  const calendarList = environment.INKBOARD_HOME_ASSISTANT_CALENDAR;

  if (baseUrlValue === undefined && token === undefined) {
    if (calendarList !== undefined) {
      throw new Error(
        "INKBOARD_HOME_ASSISTANT_CALENDAR requires INKBOARD_HOME_ASSISTANT_URL and INKBOARD_HOME_ASSISTANT_TOKEN",
      );
    }
    return null;
  }
  if (baseUrlValue === undefined || token === undefined) {
    throw new Error(
      "INKBOARD_HOME_ASSISTANT_URL and INKBOARD_HOME_ASSISTANT_TOKEN must be configured together",
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new Error("INKBOARD_HOME_ASSISTANT_URL must be a valid absolute URL");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("INKBOARD_HOME_ASSISTANT_URL must use http or https");
  }
  if (baseUrl.username !== "" || baseUrl.password !== "") {
    throw new Error("INKBOARD_HOME_ASSISTANT_URL must not include credentials");
  }
  if (token.trim() === "") {
    throw new Error("INKBOARD_HOME_ASSISTANT_TOKEN must not be empty");
  }
  const calendarEntities = [
    ...new Set(
      (calendarList ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
    ),
  ];
  for (const entityId of calendarEntities) {
    if (!CALENDAR_ENTITY_PATTERN.test(entityId)) {
      throw new Error(
        `INKBOARD_HOME_ASSISTANT_CALENDAR must list calendar entity IDs; got ${entityId}`,
      );
    }
  }

  const timeZone = parseTimeZone(environment);

  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    token: token.trim(),
    calendarEntities,
    timeZone,
    lookAheadDays: parseInteger(
      "INKBOARD_CALENDAR_LOOK_AHEAD_DAYS",
      environment.INKBOARD_CALENDAR_LOOK_AHEAD_DAYS,
      7,
      1,
      31,
    ),
    refreshIntervalSeconds: parseInteger(
      "INKBOARD_CALENDAR_REFRESH_SECONDS",
      environment.INKBOARD_CALENDAR_REFRESH_SECONDS,
      300,
      60,
      3600,
    ),
  };
}

function parseMicrosoftTodoConfig(environment: NodeJS.ProcessEnv): MicrosoftTodoConfig {
  const clientId = (environment.INKBOARD_MICROSOFT_CLIENT_ID ?? "").trim();
  if (clientId !== "" && !MICROSOFT_CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error("INKBOARD_MICROSOFT_CLIENT_ID must be an Application (client) ID GUID");
  }
  const tenant = (environment.INKBOARD_MICROSOFT_TENANT ?? "").trim() || "common";
  if (!MICROSOFT_TENANT_PATTERN.test(tenant)) {
    throw new Error(
      "INKBOARD_MICROSOFT_TENANT must be common, consumers, organizations, or a tenant",
    );
  }
  return {
    clientId: clientId === "" ? null : clientId.toLowerCase(),
    tenant,
    refreshIntervalSeconds: parseInteger(
      "INKBOARD_TODO_REFRESH_SECONDS",
      environment.INKBOARD_TODO_REFRESH_SECONDS,
      300,
      60,
      3600,
    ),
  };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ControllerConfig {
  const dataDirectory = resolve(cwd, environment.INKBOARD_DATA_DIR ?? ".inkboard");

  return {
    host: environment.INKBOARD_HOST ?? "127.0.0.1",
    port: parsePort(environment.INKBOARD_PORT),
    deviceApiToken: parseDeviceApiToken(environment.INKBOARD_DEVICE_API_TOKEN, environment),
    dataDirectory,
    artifactDirectory: resolve(
      cwd,
      environment.INKBOARD_ARTIFACT_DIR ?? resolve(dataDirectory, "artifacts"),
    ),
    databasePath: resolve(
      cwd,
      environment.INKBOARD_DATABASE_PATH ?? resolve(dataDirectory, "inkboard.sqlite3"),
    ),
    migrationDirectory: resolve(
      cwd,
      environment.INKBOARD_MIGRATION_DIR ?? "apps/controller/migrations",
    ),
    webRoot: resolve(cwd, environment.INKBOARD_WEB_ROOT ?? "apps/web/dist"),
    enableDevelopmentRoutes: parseBoolean(
      environment.INKBOARD_ENABLE_DEVELOPMENT_ROUTES,
      environment.NODE_ENV !== "production",
    ),
    logLevel: environment.INKBOARD_LOG_LEVEL ?? "info",
    appMode: environment.INKBOARD_APP_MODE === "home_assistant" ? "home_assistant" : "standalone",
    devicePort:
      environment.INKBOARD_DEVICE_PORT === undefined
        ? null
        : parsePort(environment.INKBOARD_DEVICE_PORT, "INKBOARD_DEVICE_PORT"),
    adminAllowedAddresses: parseAddressList(environment.INKBOARD_ADMIN_ALLOWED_ADDRESSES),
    timeZone: parseTimeZone(environment),
    homeAssistant: parseHomeAssistantConfig(environment),
    microsoftTodo: parseMicrosoftTodoConfig(environment),
    secretKey: environment.INKBOARD_SECRET_KEY,
  };
}
