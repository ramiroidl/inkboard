import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { SettingsStore } from "./db/settings-store.js";
import { formatEntityValue } from "./widgets/entity/index.js";
import { wrapText } from "./widgets/sdk.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function createApp(options: { homeAssistant?: boolean } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "inkboard-screens-"));
  temporaryDirectories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    INKBOARD_DATA_DIR: dataDirectory,
    INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
    INKBOARD_LOG_LEVEL: "silent",
    INKBOARD_TIME_ZONE: "America/Chicago",
    ...(options.homeAssistant === true
      ? {
          INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
          INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
          INKBOARD_HOME_ASSISTANT_CALENDAR: "calendar.family",
        }
      : {}),
  });

  const clock = { now: new Date("2026-10-31T15:00:00.000Z") };
  let temperature = "21.46";
  let homeAssistantDown = false;
  const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (homeAssistantDown) {
      throw new Error("Home Assistant is unavailable");
    }
    if (url.pathname === "/api/states/sensor.living_room_temperature") {
      return Response.json({
        entity_id: "sensor.living_room_temperature",
        state: temperature,
        attributes: { unit_of_measurement: "°C", friendly_name: "Living room" },
      });
    }
    if (url.pathname.startsWith("/api/calendars/")) {
      return Response.json([
        {
          summary: "Dentist",
          start: { dateTime: "2026-10-31T15:30:00-05:00" },
          end: { dateTime: "2026-10-31T16:00:00-05:00" },
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  });

  const app = await buildApp(config, { fetchImplementation, now: () => clock.now });
  const authorization = ["Bearer", config.deviceApiToken].join(" ");
  return {
    app,
    config,
    clock,
    fetchImplementation,
    authorization,
    setTemperature: (value: string) => {
      temperature = value;
    },
    setHomeAssistantDown: (value: boolean) => {
      homeAssistantDown = value;
    },
  };
}

const dashboard = {
  name: "Living room",
  widgets: [
    { type: "heading", text: "Good afternoon" },
    { type: "datetime", format: "datetime" },
    { type: "entity", entityId: "sensor.living_room_temperature", label: "" },
    { type: "entity", entityId: "sensor.missing", label: "Missing" },
    { type: "divider" },
    { type: "calendar", maxEvents: 3 },
    { type: "text", text: "Remember to water the plants." },
  ],
};

async function checkIn(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  authorization: string,
  buttonEvent = "none",
  displayResult = "displayed",
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/device/check-in",
    headers: { authorization },
    payload: {
      deviceId: "inkboard-og",
      firmwareVersion: "0.3.1",
      model: "seeed-ee04-800x480-mono",
      width: 800,
      height: 480,
      wakeReason: "cold_boot",
      buttonEvent,
      displayResult,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ screenId: string }>().screenId;
}

describe("custom screens", () => {
  it("migrates inherited selections and customized screen references once", async () => {
    const { app, config, authorization, clock, fetchImplementation } = await createApp({
      homeAssistant: true,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens",
      payload: {
        name: "My agenda",
        widgets: [
          { type: "calendar", maxEvents: 3, calendars: [] },
          {
            type: "calendar_month",
            calendars: ["calendar.work"],
            weekStart: "monday",
            maxEvents: 4,
            crossOutPastDays: true,
            weather: false,
          },
          { type: "todo", maxItems: 5 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    await checkIn(app, authorization);
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/rotation",
      payload: { screenIds: ["calendar", "orientation"], intervalMinutes: 15 },
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules",
      payload: { rules: [{ screenId: "calendar", days: [1], start: "07:00", end: "09:00" }] },
    });
    await app.close();

    const database = await openDatabase(config);
    const store = new SettingsStore(database, () => clock.now);
    store.delete("widgetInstanceSelections");
    store.delete("migratedScreenTemplates");
    store.set("customizedBuiltins", { calendar: id });
    store.set("microsoftTodo.selection", { listIds: ["groceries"] });
    database.raw.prepare("DELETE FROM custom_screens WHERE id = ?").run("calendar");
    database.close();

    let restarted = await buildApp(config, { fetchImplementation, now: () => clock.now });
    const read = async () =>
      (
        await restarted.inject({
          method: "GET",
          url: `/api/v1/admin/screens/${id}`,
        })
      ).json<{ widgets: { calendars?: string[]; lists?: string[] }[] }>();
    expect((await read()).widgets).toMatchObject([
      { calendars: ["calendar.family"] },
      { calendars: ["calendar.work"] },
      { lists: ["groceries"] },
    ]);
    const listing = await restarted.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(listing.json()).toMatchObject({
      rotation: { screenIds: [id, "orientation"] },
      schedules: [{ screenId: id }],
    });
    const devices = await restarted.inject({ method: "GET", url: "/api/v1/admin/devices" });
    expect(devices.json()).toMatchObject({ devices: [{ currentScreenId: id }] });

    await restarted.inject({
      method: "PUT",
      url: `/api/v1/admin/screens/${id}`,
      payload: { name: "My agenda", widgets: [{ type: "calendar", maxEvents: 3, calendars: [] }] },
    });
    await restarted.close();
    restarted = await buildApp(config, { fetchImplementation, now: () => clock.now });
    expect((await read()).widgets).toEqual([{ type: "calendar", maxEvents: 3, calendars: [] }]);
    await restarted.inject({ method: "DELETE", url: `/api/v1/admin/screens/${id}` });
    expect(
      (await restarted.inject({ method: "GET", url: "/api/v1/admin/screens" })).json(),
    ).toMatchObject({
      screens: [{ id: "orientation" }],
      rotation: { screenIds: ["orientation"] },
      schedules: [],
    });
    await restarted.close();
    restarted = await buildApp(config, { fetchImplementation, now: () => clock.now });
    expect(
      (await restarted.inject({ method: "GET", url: "/api/v1/admin/screens" })).json(),
    ).toMatchObject({ screens: [{ id: "orientation" }] });
    await restarted.close();
  });

  it("creates, renders, updates, and deletes custom screens", async () => {
    const { app, authorization, setTemperature, setHomeAssistantDown, clock } = await createApp({
      homeAssistant: true,
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens",
      payload: dashboard,
    });
    expect(created.statusCode).toBe(201);
    const screen = created.json<{ id: string; widgets: unknown[] }>();
    expect(screen.id).toMatch(/^screen_[a-f0-9]{12}$/);
    expect(screen.widgets).toHaveLength(7);

    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(listed.json()).toMatchObject({
      screens: [
        { id: "calendar", kind: "custom" },
        { id: "orientation", kind: "diagnostic" },
        { id: screen.id, kind: "custom", name: "Living room" },
      ],
    });

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/admin/screens/${screen.id}/preview.bmp`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).toHaveLength(48_062);

    await checkIn(app, authorization);
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/devices/inkboard-og/screen",
      payload: { screenId: screen.id },
    });
    expect(selected.statusCode).toBe(200);

    const imageUrl = "/api/v1/device/image.bmp?device=inkboard-og";
    const first = await app.inject({ method: "GET", url: imageUrl, headers: { authorization } });
    expect(first.headers["x-screen-id"]).toBe(screen.id);
    expect(first.rawPayload).toHaveLength(48_062);

    // Unchanged data and time renders the same artifact.
    const unchanged = await app.inject({
      method: "GET",
      url: imageUrl,
      headers: { authorization, "if-none-match": first.headers.etag! },
    });
    expect(unchanged.statusCode).toBe(304);

    // A changed entity value produces a new image after the state cache expires.
    setTemperature("19.04");
    clock.now = new Date(clock.now.getTime() + 301_000);
    const changed = await app.inject({ method: "GET", url: imageUrl, headers: { authorization } });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);

    // A Home Assistant outage keeps the last good entity value instead of failing.
    setHomeAssistantDown(true);
    clock.now = new Date(clock.now.getTime() + 301_000);
    const outage = await app.inject({ method: "GET", url: imageUrl, headers: { authorization } });
    expect(outage.statusCode).toBe(200);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/screens/${screen.id}`,
      payload: { name: "Hallway", widgets: [{ type: "heading", text: "Hallway" }] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Hallway", widgets: [{ type: "heading" }] });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/screens/${screen.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    const missing = await app.inject({ method: "GET", url: `/api/v1/admin/screens/${screen.id}` });
    expect(missing.statusCode).toBe(404);

    const fallback = await app.inject({ method: "GET", url: imageUrl, headers: { authorization } });
    expect(fallback.headers["x-screen-id"]).toBe("calendar");

    await app.close();
  });

  it("renders unsaved drafts and validates widget input", async () => {
    const { app } = await createApp();

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: dashboard,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toBe("image/bmp");
    expect(preview.rawPayload).toHaveLength(48_062);

    for (const widgets of [
      [{ type: "entity", entityId: "not an entity", label: "" }],
      [{ type: "calendar", maxEvents: 20 }],
      [{ type: "unknown" }],
      Array.from({ length: 13 }, () => ({ type: "divider" })),
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/admin/screens",
        payload: { name: "Invalid", widgets },
      });
      expect(invalid.statusCode).toBe(400);
    }

    await app.close();
  });

  it("rotates screens on an interval and keeps manual choices for a full interval", async () => {
    const { app, authorization, clock } = await createApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens",
      payload: { name: "Clock", widgets: [{ type: "datetime", format: "time" }] },
    });
    const screenId = created.json<{ id: string }>().id;
    const screenAt = async () =>
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/device/image.bmp?device=inkboard-og",
          headers: { authorization },
        })
      ).headers["x-screen-id"];

    expect(await checkIn(app, authorization)).toBe("orientation");

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/rotation",
      payload: { screenIds: ["orientation", "missing"], intervalMinutes: 15 },
    });
    expect(invalid.statusCode).toBe(400);
    const duplicate = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/rotation",
      payload: { screenIds: ["orientation", "orientation"], intervalMinutes: 15 },
    });
    expect(duplicate.statusCode).toBe(400);

    const rotation = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/rotation",
      payload: { screenIds: ["orientation", screenId], intervalMinutes: 15 },
    });
    expect(rotation.statusCode).toBe(200);

    expect(await screenAt()).toBe("orientation");
    clock.now = new Date(clock.now.getTime() + 15 * 60_000);
    expect(await screenAt()).toBe(screenId);
    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    expect(await screenAt()).toBe(screenId);
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    expect(await screenAt()).toBe("orientation");

    // A button press resets the interval.
    clock.now = new Date(clock.now.getTime() + 14 * 60_000);
    expect(await checkIn(app, authorization, "next", "button")).toBe(screenId);
    clock.now = new Date(clock.now.getTime() + 2 * 60_000);
    expect(await screenAt()).toBe(screenId);

    // Deleting a screen removes it from the rotation.
    await app.inject({ method: "DELETE", url: `/api/v1/admin/screens/${screenId}` });
    const after = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(after.json()).toMatchObject({ rotation: { screenIds: ["orientation"] } });

    await app.close();
  });
});

describe("custom screen rendering helpers", () => {
  it("hides the test pattern unless it is the only screen", async () => {
    const { app } = await createApp();
    const screenIds = async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
      return response.json<{ screens: { id: string }[]; testPatternHidden: boolean }>();
    };
    expect(await screenIds()).toMatchObject({ testPatternHidden: false });

    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/test-pattern",
      payload: { hidden: true },
    });
    // No other screen exists, so the test pattern stays as the fallback.
    expect((await screenIds()).screens.map((screen) => screen.id)).toEqual(["orientation"]);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens",
      payload: { name: "Notes", widgets: [{ type: "text", text: "Hello" }] },
    });
    const screenId = created.json<{ id: string }>().id;
    const hidden = await screenIds();
    expect(hidden.testPatternHidden).toBe(true);
    expect(hidden.screens.map((screen) => screen.id)).toEqual([screenId]);

    await app.inject({ method: "DELETE", url: `/api/v1/admin/screens/${screenId}` });
    expect((await screenIds()).screens.map((screen) => screen.id)).toEqual(["orientation"]);
    await app.close();
  });

  it("wraps text and limits lines", () => {
    expect(wrapText("one two three four", 9, 4)).toEqual(["one two", "three", "four"]);
    expect(wrapText("a\nb", 10, 4)).toEqual(["a", "b"]);
    const limited = wrapText("aaaa bbbb cccc dddd", 4, 2);
    expect(limited).toHaveLength(2);
    expect(limited[1]).toMatch(/…$/);
  });

  it("formats entity values", () => {
    expect(
      formatEntityValue({ entityId: "sensor.t", state: "21.46", unit: "°C", friendlyName: null }),
    ).toBe("21.5 °C");
    expect(
      formatEntityValue({ entityId: "light.k", state: "on", unit: null, friendlyName: null }),
    ).toBe("on");
    expect(formatEntityValue(null)).toBe("—");
  });
});
