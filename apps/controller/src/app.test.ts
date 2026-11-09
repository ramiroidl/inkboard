import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const temporaryDirectories: string[] = [];

async function testConfig(environment: NodeJS.ProcessEnv = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "inkboard-test-"));
  temporaryDirectories.push(dataDirectory);
  return loadConfig(
    {
      NODE_ENV: "test",
      INKBOARD_DATA_DIR: dataDirectory,
      INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
      INKBOARD_ENABLE_DEVELOPMENT_ROUTES: "true",
      INKBOARD_LOG_LEVEL: "silent",
      ...environment,
    },
    process.cwd(),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("controller", () => {
  it("reports liveness and readiness independently", async () => {
    const app = await buildApp(await testConfig());

    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: "ok", service: "inkboard-controller" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ok",
      database: "ready",
      artifactStore: "ready",
    });

    await app.close();
  });

  it("serves an exact monochrome orientation BMP with cache validation", async () => {
    const app = await buildApp(await testConfig());

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/development/orientation.bmp",
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("image/bmp");
    expect(first.rawPayload).toHaveLength(48_062);
    expect(first.headers.etag).toMatch(/^"sha256:[a-f0-9]{64}"$/);

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/v1/development/orientation.bmp",
      headers: { "if-none-match": first.headers.etag! },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload).toHaveLength(0);

    await app.close();
  });

  it("protects the device image and supports HTTP cache validation", async () => {
    const app = await buildApp(await testConfig());

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toBe("Bearer");

    const authorization = "Bearer test-device-token-with-at-least-32-characters";
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
      headers: { authorization },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("image/bmp");
    expect(first.rawPayload).toHaveLength(48_062);
    expect(first.headers["x-screen-revision"]).toMatch(/^sha256:[a-f0-9]{64}$/);

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
      headers: {
        authorization,
        "if-none-match": first.headers.etag!,
      },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload).toHaveLength(0);
    expect(unchanged.headers.etag).toBe(first.headers.etag);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
      headers: { authorization, "if-none-match": `"sha256:old", ${first.headers.etag!}` },
    });
    expect(listed.statusCode).toBe(304);

    await app.close();
  });

  it("records authenticated device check-ins for administration", async () => {
    const app = await buildApp(await testConfig());
    const body = {
      deviceId: "inkboard-og",
      firmwareVersion: "0.2.0",
      model: "seeed-ee04-800x480-mono",
      width: 800,
      height: 480,
      screenRevision: "sha256:test-revision",
      wakeReason: "key2",
      wifiRssi: -52,
      batteryVoltage: 3.91,
      buttonEvent: "refresh",
      displayResult: "displayed",
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/v1/device/check-in",
      payload: body,
    });
    expect(unauthorized.statusCode).toBe(401);

    const checkIn = await app.inject({
      method: "POST",
      url: "/api/v1/device/check-in",
      headers: {
        authorization: "Bearer test-device-token-with-at-least-32-characters",
      },
      payload: body,
    });
    expect(checkIn.statusCode).toBe(200);
    const checkInBody = checkIn.json<{
      screenRevision: string;
    }>();
    expect(checkInBody).toMatchObject({
      status: "ok",
      nextRefreshSeconds: 900,
    });
    expect(checkInBody.screenRevision).toMatch(/^sha256:[a-f0-9]{64}:battery\d+$/);

    const devices = await app.inject({
      method: "GET",
      url: "/api/v1/admin/devices",
    });
    expect(devices.statusCode).toBe(200);
    expect(devices.json()).toEqual({
      devices: [
        expect.objectContaining({
          id: "inkboard-og",
          firmwareVersion: "0.2.0",
          lastWakeReason: "key2",
          lastWifiRssi: -52,
          lastBatteryVoltage: 3.91,
          lastButtonEvent: "refresh",
          lastDisplayResult: "displayed",
        }),
      ],
    });

    await app.close();
  });

  it("renders Home Assistant calendar events and preserves the last good screen", async () => {
    let now = new Date("2026-10-30T13:00:00.000Z");
    let failRefresh = false;
    const homeAssistantFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/calendars" && !failRefresh) {
        return Response.json([{ entity_id: "calendar.family", name: "Family" }]);
      }
      expect(url.pathname).toMatch(/^\/api\/calendars(\/calendar\.family)?$/);
      if (url.pathname === "/api/calendars/calendar.family") {
        expect(url.searchParams.get("start")).toBe(now.toISOString());
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-home-assistant-token",
      );
      if (failRefresh) {
        throw new Error("Home Assistant is unavailable");
      }
      return new Response(
        JSON.stringify([
          {
            summary: "Dentist appointment",
            start: { dateTime: "2026-10-30T15:30:00-05:00" },
            end: { dateTime: "2026-10-30T16:00:00-05:00" },
            location: "Downtown clinic",
          },
          {
            summary: "School holiday",
            start: { date: "2026-10-31" },
            end: { date: "2026-11-01" },
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const config = await testConfig({
      INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
      INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
      INKBOARD_HOME_ASSISTANT_CALENDAR: "calendar.family",
      INKBOARD_TIME_ZONE: "America/Chicago",
    });
    const app = await buildApp(config, {
      fetchImplementation: homeAssistantFetch,
      now: () => now,
    });

    const authorization = ["Bearer", config.deviceApiToken].join(" ");
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
      headers: { authorization },
    });
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload).toHaveLength(48_062);

    const status = await app.inject({ method: "GET", url: "/api/v1/admin/status" });
    expect(status.json()).toMatchObject({
      calendar: {
        configured: true,
        homeAssistantConfigured: true,
        state: "ready",
        entityIds: ["calendar.family"],
        calendars: [{ entityId: "calendar.family", name: "Family", eventCount: 2 }],
        eventCount: 2,
        lastError: null,
      },
    });

    failRefresh = true;
    now = new Date(now.getTime() + 301_000);
    const fallback = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
      headers: { authorization },
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers.etag).toBe(first.headers.etag);

    const degraded = await app.inject({ method: "GET", url: "/api/v1/admin/status" });
    expect(degraded.json()).toMatchObject({
      calendar: {
        state: "degraded",
        eventCount: 2,
        lastError: "Home Assistant is unavailable",
      },
    });

    await app.close();
  });

  it("navigates screens per device with buttons and admin selection", async () => {
    const homeAssistantFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const config = await testConfig({
      INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
      INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
      INKBOARD_HOME_ASSISTANT_CALENDAR: "calendar.family",
    });
    const app = await buildApp(config, { fetchImplementation: homeAssistantFetch });
    const authorization = ["Bearer", config.deviceApiToken].join(" ");
    const checkIn = async (buttonEvent: string, displayResult: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/device/check-in",
        headers: { authorization },
        payload: {
          deviceId: "inkboard-og",
          firmwareVersion: "0.3.0",
          model: "seeed-ee04-800x480-mono",
          width: 800,
          height: 480,
          wakeReason: "key1",
          buttonEvent,
          displayResult,
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ screenId: string }>().screenId;
    };
    const imageScreen = async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/device/image.bmp?device=inkboard-og",
        headers: { authorization },
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toHaveLength(48_062);
      return response.headers["x-screen-id"];
    };

    const screens = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(screens.json()).toMatchObject({
      defaultScreenId: "calendar",
      screens: [{ id: "calendar" }, { id: "orientation" }],
      rotation: { screenIds: [], intervalMinutes: 15 },
    });

    expect(await checkIn("none", "displayed")).toBe("calendar");
    expect(await imageScreen()).toBe("calendar");

    expect(await checkIn("next", "button")).toBe("orientation");
    expect(await imageScreen()).toBe("orientation");
    expect(await checkIn("none", "displayed")).toBe("orientation");

    expect(await checkIn("next", "button")).toBe("calendar");
    expect(await checkIn("previous", "button")).toBe("orientation");
    expect(await checkIn("next", "displayed")).toBe("orientation");

    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/inkboard-og/screen",
      payload: { screenId: "calendar" },
    });
    expect(selected.statusCode).toBe(200);
    expect(await imageScreen()).toBe("calendar");

    const devices = await app.inject({ method: "GET", url: "/api/v1/admin/devices" });
    expect(devices.json()).toMatchObject({ devices: [{ currentScreenId: "calendar" }] });

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/inkboard-og/screen",
      payload: { screenId: "missing" },
    });
    expect(invalid.statusCode).toBe(400);

    const unknownDevice = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/unknown/screen",
      payload: { screenId: "orientation" },
    });
    expect(unknownDevice.statusCode).toBe(404);

    const preview = await app.inject({
      method: "GET",
      url: "/api/v1/admin/screens/orientation/preview.bmp",
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).toHaveLength(48_062);

    await app.close();
  });

  it("keeps a single test pattern screen when no calendar is configured", async () => {
    const config = await testConfig();
    const app = await buildApp(config);
    const authorization = ["Bearer", config.deviceApiToken].join(" ");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/device/check-in",
      headers: { authorization },
      payload: {
        deviceId: "inkboard-og",
        firmwareVersion: "0.3.0",
        model: "seeed-ee04-800x480-mono",
        width: 800,
        height: 480,
        wakeReason: "key3",
        buttonEvent: "next",
        displayResult: "button",
      },
    });
    expect(response.json()).toMatchObject({ screenId: "orientation" });

    await app.close();
  });
});
