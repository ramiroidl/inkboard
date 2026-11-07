import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAppEnvironment } from "./app-mode.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { homeAssistantApiUrl } from "./integrations/home-assistant-url.js";
import { normalizeAddress, startDeviceListener } from "./listeners.js";

const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dataDirectory(options?: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "inkboard-app-"));
  directories.push(directory);
  if (options !== undefined) {
    await writeFile(join(directory, "options.json"), JSON.stringify(options));
  }
  return directory;
}

describe("Home Assistant App environment", () => {
  it("leaves the environment unchanged outside the App", async () => {
    const environment = { INKBOARD_PORT: "1234" };
    await expect(resolveAppEnvironment(environment)).resolves.toBe(environment);
  });

  it("maps App options and the Supervisor token onto the controller settings", async () => {
    const directory = await dataDirectory({
      time_zone: "America/Mexico_City",
      calendar_look_ahead_days: 14,
      calendar_refresh_seconds: 600,
      log_level: "warn",
    });
    const environment = await resolveAppEnvironment(
      { SUPERVISOR_TOKEN: "supervisor-token", TZ: "UTC" },
      { dataDirectory: directory },
    );
    expect(environment).toMatchObject({
      NODE_ENV: "production",
      INKBOARD_APP_MODE: "home_assistant",
      INKBOARD_DATA_DIR: directory,
      INKBOARD_HOST: "0.0.0.0",
      INKBOARD_PORT: "8099",
      INKBOARD_DEVICE_PORT: "8100",
      INKBOARD_ADMIN_ALLOWED_ADDRESSES: "172.30.32.2",
      INKBOARD_HOME_ASSISTANT_URL: "http://supervisor/core",
      INKBOARD_HOME_ASSISTANT_TOKEN: "supervisor-token",
      INKBOARD_TIME_ZONE: "America/Mexico_City",
      INKBOARD_CALENDAR_LOOK_AHEAD_DAYS: "14",
      INKBOARD_CALENDAR_REFRESH_SECONDS: "600",
      INKBOARD_LOG_LEVEL: "warn",
    });
    expect(environment.INKBOARD_HOME_ASSISTANT_CALENDAR).toBeUndefined();

    const config = loadConfig(environment);
    expect(config).toMatchObject({
      appMode: "home_assistant",
      devicePort: 8100,
      adminAllowedAddresses: ["172.30.32.2"],
      homeAssistant: { baseUrl: "http://supervisor/core", calendarEntities: [] },
    });
  });

  it("generates a device token once and keeps it, unless one is configured", async () => {
    const directory = await dataDirectory({});
    const first = await resolveAppEnvironment(
      { SUPERVISOR_TOKEN: "t" },
      { dataDirectory: directory },
    );
    expect(first.INKBOARD_DEVICE_API_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(join(directory, "device-api-token"), "utf8")).trim()).toBe(
      first.INKBOARD_DEVICE_API_TOKEN,
    );
    const second = await resolveAppEnvironment(
      { SUPERVISOR_TOKEN: "t" },
      { dataDirectory: directory },
    );
    expect(second.INKBOARD_DEVICE_API_TOKEN).toBe(first.INKBOARD_DEVICE_API_TOKEN);
    // With no time zone option, the Supervisor's TZ is used.
    expect(second.INKBOARD_TIME_ZONE).toBe("UTC");

    await writeFile(
      join(directory, "options.json"),
      JSON.stringify({ device_api_token: "x".repeat(40) }),
    );
    const configured = await resolveAppEnvironment(
      { SUPERVISOR_TOKEN: "t" },
      { dataDirectory: directory },
    );
    expect(configured.INKBOARD_DEVICE_API_TOKEN).toBe("x".repeat(40));

    await writeFile(join(directory, "options.json"), JSON.stringify({ device_api_token: "short" }));
    await expect(
      resolveAppEnvironment({ SUPERVISOR_TOKEN: "t" }, { dataDirectory: directory }),
    ).rejects.toThrow("at least 32 characters");
  });
});

describe("Home Assistant API URLs", () => {
  it("keeps the base path of the Supervisor proxy", () => {
    expect(homeAssistantApiUrl("http://supervisor/core", "api/states").href).toBe(
      "http://supervisor/core/api/states",
    );
    expect(homeAssistantApiUrl("http://ha.local:8123/", "/api/calendars").href).toBe(
      "http://ha.local:8123/api/calendars",
    );
  });

  it("calls Home Assistant through the Supervisor with the App's token", async () => {
    const directory = await dataDirectory({});
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/core/api/calendars") {
        return Response.json([{ entity_id: "calendar.family", name: "Family" }]);
      }
      if (url.pathname === "/core/api/states") {
        return Response.json([
          { entity_id: "sensor.outdoor", attributes: { friendly_name: "Outdoor" } },
          { entity_id: "todo.shopping", attributes: { friendly_name: "Shopping" } },
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    const config = loadConfig(
      await resolveAppEnvironment(
        { SUPERVISOR_TOKEN: "supervisor-token", INKBOARD_LOG_LEVEL: "silent" },
        { dataDirectory: directory },
      ),
    );
    const app = await buildApp({ ...config, logLevel: "silent" }, { fetchImplementation });
    cleanups.push(() => app.close());
    const ingress = { remoteAddress: "172.30.32.2" };

    const calendars = await app.inject({
      method: "GET",
      url: "/api/v1/admin/calendars",
      ...ingress,
    });
    expect(calendars.json()).toMatchObject({
      available: [{ entityId: "calendar.family", name: "Family" }],
    });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url instanceof URL ? url.href : url).toBe("http://supervisor/core/api/calendars");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      ["Bearer", "supervisor-token"].join(" "),
    );

    const sensors = await app.inject({
      method: "GET",
      url: "/api/v1/admin/entities?domain=sensor",
      ...ingress,
    });
    expect(sensors.json()).toEqual({
      entities: [{ entityId: "sensor.outdoor", name: "Outdoor", domain: "sensor" }],
      error: null,
    });

    const status = await app.inject({ method: "GET", url: "/api/v1/admin/status", ...ingress });
    expect(status.json()).toMatchObject({
      app: {
        mode: "home_assistant",
        devicePort: 8100,
        deviceApiToken: config.deviceApiToken,
      },
    });
  });
});

describe("listener separation", () => {
  it("hides admin APIs from the LAN and serves devices on their own port", async () => {
    const directory = await dataDirectory();
    const config = loadConfig({
      NODE_ENV: "test",
      INKBOARD_DATA_DIR: directory,
      INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
      INKBOARD_LOG_LEVEL: "silent",
      INKBOARD_ADMIN_ALLOWED_ADDRESSES: "172.30.32.2",
      INKBOARD_DEVICE_PORT: "8100",
    });
    const app = await buildApp(config);
    cleanups.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const deviceServer = await startDeviceListener(app, "127.0.0.1", 0);
    cleanups.push(() => new Promise<void>((resolve) => deviceServer.close(() => resolve())));
    const adminBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const deviceBase = `http://127.0.0.1:${(deviceServer.address() as AddressInfo).port}`;
    const authorization = ["Bearer", config.deviceApiToken].join(" ");

    // Main listener: only the ingress proxy may use admin APIs; health checks always work.
    expect((await fetch(`${adminBase}/api/v1/admin/status`)).status).toBe(403);
    expect((await fetch(`${adminBase}/`)).status).toBe(403);
    expect((await fetch(`${adminBase}/health/ready`)).status).toBe(200);
    const fromProxy = await app.inject({
      method: "GET",
      url: "/api/v1/admin/status",
      remoteAddress: "::ffff:172.30.32.2",
    });
    expect(fromProxy.statusCode).toBe(200);

    // Device listener: device and health endpoints only.
    expect((await fetch(`${deviceBase}/api/v1/admin/status`)).status).toBe(404);
    expect((await fetch(`${deviceBase}/api/v1/admin/screens`)).status).toBe(404);
    expect((await fetch(`${deviceBase}/`)).status).toBe(404);
    expect((await fetch(`${deviceBase}/health/live`)).status).toBe(200);
    expect((await fetch(`${deviceBase}/api/v1/device/image.bmp`)).status).toBe(401);
    const image = await fetch(`${deviceBase}/api/v1/device/image.bmp`, {
      headers: { authorization },
    });
    expect(image.status).toBe(200);
    expect((await image.arrayBuffer()).byteLength).toBe(48_062);
  });

  it("normalizes IPv4-mapped addresses", () => {
    expect(normalizeAddress("::ffff:172.30.32.2")).toBe("172.30.32.2");
    expect(normalizeAddress("172.30.32.2")).toBe("172.30.32.2");
    expect(normalizeAddress(undefined)).toBe("");
  });
});
