import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Options from the App's configuration tab, stored by the Supervisor in options.json. */
export interface HomeAssistantAppOptions {
  device_api_token?: string;
  time_zone?: string;
  calendar_look_ahead_days?: number;
  calendar_refresh_seconds?: number;
  microsoft_client_id?: string;
  microsoft_tenant?: string;
  log_level?: string;
}

/** The Supervisor's ingress proxy; only it may reach the admin listener inside the App. */
export const SUPERVISOR_INGRESS_ADDRESS = "172.30.32.2";
export const APP_ADMIN_PORT = 8099;
export const APP_DEVICE_PORT = 8100;
const TOKEN_FILE = "device-api-token";

export function isHomeAssistantApp(environment: NodeJS.ProcessEnv): boolean {
  return (environment.SUPERVISOR_TOKEN ?? "") !== "";
}

async function readOptions(path: string): Promise<HomeAssistantAppOptions> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HomeAssistantAppOptions;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read App options from ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Uses the configured device token, or a generated one that is kept in the App's data so
 * it survives restarts, updates, and backups.
 */
async function resolveDeviceToken(
  options: HomeAssistantAppOptions,
  dataDirectory: string,
): Promise<string> {
  const configured = (options.device_api_token ?? "").trim();
  if (configured !== "") {
    if (configured.length < 32) {
      throw new Error("The device_api_token option must contain at least 32 characters");
    }
    return configured;
  }
  const tokenPath = join(dataDirectory, TOKEN_FILE);
  try {
    const stored = (await readFile(tokenPath, "utf8")).trim();
    if (stored.length >= 32) {
      return stored;
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const generated = randomBytes(32).toString("hex");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(tokenPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

/**
 * Maps the Home Assistant App runtime onto the controller's environment settings. Outside
 * the App, the environment is returned unchanged.
 */
export async function resolveAppEnvironment(
  environment: NodeJS.ProcessEnv,
  paths: { optionsPath?: string; dataDirectory?: string } = {},
): Promise<NodeJS.ProcessEnv> {
  if (!isHomeAssistantApp(environment)) {
    return environment;
  }
  const dataDirectory = paths.dataDirectory ?? "/data";
  const options = await readOptions(paths.optionsPath ?? join(dataDirectory, "options.json"));
  const timeZone = (options.time_zone ?? "").trim();

  return {
    ...environment,
    NODE_ENV: "production",
    INKBOARD_APP_MODE: "home_assistant",
    INKBOARD_DATA_DIR: dataDirectory,
    INKBOARD_HOST: environment.INKBOARD_HOST ?? "0.0.0.0",
    INKBOARD_PORT: environment.INKBOARD_PORT ?? String(APP_ADMIN_PORT),
    INKBOARD_DEVICE_PORT: environment.INKBOARD_DEVICE_PORT ?? String(APP_DEVICE_PORT),
    INKBOARD_ADMIN_ALLOWED_ADDRESSES:
      environment.INKBOARD_ADMIN_ALLOWED_ADDRESSES ?? SUPERVISOR_INGRESS_ADDRESS,
    INKBOARD_DEVICE_API_TOKEN: await resolveDeviceToken(options, dataDirectory),
    // The Supervisor proxies the Core API and authenticates the App's own token.
    INKBOARD_HOME_ASSISTANT_URL: environment.INKBOARD_SUPERVISOR_URL ?? "http://supervisor/core",
    INKBOARD_HOME_ASSISTANT_TOKEN: environment.SUPERVISOR_TOKEN,
    INKBOARD_TIME_ZONE: timeZone !== "" ? timeZone : (environment.TZ ?? "UTC"),
    INKBOARD_CALENDAR_LOOK_AHEAD_DAYS: String(options.calendar_look_ahead_days ?? 7),
    INKBOARD_CALENDAR_REFRESH_SECONDS: String(options.calendar_refresh_seconds ?? 300),
    INKBOARD_MICROSOFT_CLIENT_ID: options.microsoft_client_id ?? "",
    INKBOARD_MICROSOFT_TENANT: options.microsoft_tenant ?? "",
    INKBOARD_LOG_LEVEL: options.log_level ?? "info",
  };
}
