import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  estimateTextWidth,
  fitToWidth,
  formatEventDay,
  formatEventTime,
} from "./artifacts/calendar-renderer.js";
import { ArtifactService } from "./artifacts/artifact-service.js";
import { CalendarService, mergeCalendarEvents } from "./calendar/calendar-service.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import type { CalendarEvent } from "./integrations/home-assistant-calendar.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const shared = {
  summary: "School pickup",
  start: { dateTime: "2026-11-06T15:00:00-06:00" },
  end: { dateTime: "2026-11-06T15:30:00-06:00" },
};
const FEEDS: Record<string, unknown[]> = {
  "calendar.family": [
    shared,
    {
      summary: "Grandparents visit",
      start: { date: "2026-11-05" },
      end: { date: "2026-11-09" },
    },
  ],
  "calendar.work": [
    shared,
    {
      summary: "Standup",
      start: { dateTime: "2026-11-06T09:00:00-06:00" },
      end: { dateTime: "2026-11-06T09:15:00-06:00" },
    },
  ],
};

function homeAssistant() {
  const down = new Set<string>();
  const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (down.has("*")) {
      throw new Error("Home Assistant is unavailable");
    }
    if (url.pathname === "/api/calendars") {
      return Response.json([
        { entity_id: "calendar.work", name: "Work" },
        { entity_id: "calendar.family", name: "Family" },
      ]);
    }
    const entityId = decodeURIComponent(url.pathname.replace("/api/calendars/", ""));
    if (down.has(entityId)) {
      return new Response("unavailable", { status: 503 });
    }
    return Response.json(FEEDS[entityId] ?? []);
  });
  return { fetchImplementation, down };
}

async function createApp(
  dataDirectory: string,
  fetchImplementation: typeof fetch,
  clock: { now: Date },
  calendars?: string,
) {
  const config = loadConfig({
    NODE_ENV: "test",
    INKBOARD_DATA_DIR: dataDirectory,
    INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
    INKBOARD_LOG_LEVEL: "silent",
    INKBOARD_TIME_ZONE: "America/Chicago",
    INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
    INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
    ...(calendars === undefined ? {} : { INKBOARD_HOME_ASSISTANT_CALENDAR: calendars }),
  });
  return buildApp(config, { fetchImplementation, now: () => clock.now });
}

async function newDataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "inkboard-calendars-"));
  directories.push(directory);
  return directory;
}

interface StatusBody {
  calendar: {
    configured: boolean;
    state: string;
    eventCount: number;
    lastError: string | null;
    calendars: { entityId: string; name: string; eventCount: number; lastError: string | null }[];
  };
}

describe("Home Assistant calendar selection", () => {
  it("discovers, selects, merges, and persists calendars", async () => {
    const dataDirectory = await newDataDirectory();
    const ha = homeAssistant();
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    let app = await createApp(dataDirectory, ha.fetchImplementation, clock);

    const initial = await app.inject({ method: "GET", url: "/api/v1/admin/status" });
    expect(initial.json<StatusBody>().calendar).toMatchObject({
      configured: false,
      homeAssistantConfigured: true,
      state: "disabled",
    });
    const screensBefore = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(screensBefore.json<{ screens: { id: string }[] }>().screens.map((s) => s.id)).toEqual([
      "orientation",
    ]);

    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/calendars" });
    expect(listed.json()).toEqual({
      available: [
        { entityId: "calendar.family", name: "Family" },
        { entityId: "calendar.work", name: "Work" },
      ],
      selected: [],
      discoveryError: null,
    });

    for (const entityIds of [
      ["sensor.temperature"],
      Array.from({ length: 11 }, (_, i) => `calendar.c${i}`),
    ]) {
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/calendars",
        payload: { entityIds },
      });
      expect(invalid.statusCode).toBe(400);
    }

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/calendars",
      payload: { entityIds: ["calendar.family", "calendar.work", "calendar.family"] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      configured: true,
      state: "ready",
      entityIds: ["calendar.family", "calendar.work"],
      // The shared pickup appears once.
      eventCount: 3,
      calendars: [
        { entityId: "calendar.family", name: "Family", eventCount: 2, lastError: null },
        { entityId: "calendar.work", name: "Work", eventCount: 2, lastError: null },
      ],
    });

    const screens = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(screens.json<{ screens: { id: string }[] }>().screens[0]!.id).toBe("calendar");
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: { name: "Agenda", widgets: [{ type: "calendar", maxEvents: 4 }] },
    });
    expect(preview.statusCode).toBe(200);
    await app.close();

    // After a restart with Home Assistant down, the saved selection and events remain.
    ha.down.add("*");
    app = await createApp(dataDirectory, ha.fetchImplementation, clock, "calendar.ignored");
    const restarted = await app.inject({ method: "GET", url: "/api/v1/admin/status" });
    expect(restarted.json<StatusBody>().calendar).toMatchObject({
      configured: true,
      state: "degraded",
      eventCount: 3,
      calendars: [
        { entityId: "calendar.family", eventCount: 2, lastError: "Home Assistant is unavailable" },
        { entityId: "calendar.work", eventCount: 2 },
      ],
    });
    const image = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
      headers: { authorization: "Bearer test-device-token-with-at-least-32-characters" },
    });
    expect(image.statusCode).toBe(200);

    const unavailable = await app.inject({ method: "GET", url: "/api/v1/admin/calendars" });
    expect(unavailable.json()).toMatchObject({
      available: [],
      selected: ["calendar.family", "calendar.work"],
      discoveryError: "Home Assistant is unavailable",
    });

    // Recovery needs no manual action once the refresh interval passes.
    ha.down.clear();
    clock.now = new Date(clock.now.getTime() + 301_000);
    await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp",
      headers: { authorization: "Bearer test-device-token-with-at-least-32-characters" },
    });
    const recovered = await app.inject({ method: "GET", url: "/api/v1/admin/status" });
    expect(recovered.json<StatusBody>().calendar).toMatchObject({
      state: "ready",
      lastError: null,
    });

    // Clearing the selection removes the Calendar screen.
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/calendars",
      payload: { entityIds: [] },
    });
    expect(cleared.json()).toMatchObject({ configured: false, state: "disabled" });
    await app.close();
  });

  it("keeps the last good events of a failing calendar and names it", async () => {
    const dataDirectory = await newDataDirectory();
    const ha = homeAssistant();
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    const app = await createApp(
      dataDirectory,
      ha.fetchImplementation,
      clock,
      "calendar.family,calendar.work",
    );
    const ready = await app.inject({ method: "GET", url: "/api/v1/admin/status" });
    expect(ready.json<StatusBody>().calendar).toMatchObject({ state: "ready", eventCount: 3 });

    ha.down.add("calendar.work");
    clock.now = new Date(clock.now.getTime() + 301_000);
    const preview = await app.inject({
      method: "GET",
      url: "/api/v1/admin/screens/calendar/preview.bmp",
    });
    expect(preview.statusCode).toBe(200);
    const degraded = await app.inject({ method: "GET", url: "/api/v1/admin/status" });
    expect(degraded.json<StatusBody>().calendar).toMatchObject({
      state: "degraded",
      eventCount: 3,
      lastError: "Work: Home Assistant calendar request returned HTTP 503",
      calendars: [
        { entityId: "calendar.family", lastError: null },
        {
          entityId: "calendar.work",
          eventCount: 2,
          lastError: expect.stringContaining("503") as unknown,
        },
      ],
    });
    await app.close();
  });

  it("lets a widget use calendars other than the admin selection", async () => {
    const dataDirectory = await newDataDirectory();
    const ha = homeAssistant();
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    const config = loadConfig({
      NODE_ENV: "test",
      INKBOARD_DATA_DIR: dataDirectory,
      INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
      INKBOARD_LOG_LEVEL: "silent",
      INKBOARD_TIME_ZONE: "America/Chicago",
      INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
      INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
      INKBOARD_HOME_ASSISTANT_CALENDAR: "calendar.family",
    });
    const database = await openDatabase(config);
    const artifacts = new ArtifactService(config, database);
    await artifacts.initialize();
    const service = new CalendarService(
      config,
      artifacts,
      database,
      ha.fetchImplementation,
      () => clock.now,
    );
    await service.initialize();

    const titles = async (entityIds?: string[]) =>
      (await service.getEvents(entityIds)).map((item) => item.title);
    expect(await titles()).toEqual(["Grandparents visit", "School pickup"]);
    expect(await titles([])).toEqual(["Grandparents visit", "School pickup"]);
    expect(await titles(["calendar.work"])).toEqual(["Standup", "School pickup"]);
    expect(await titles(["calendar.work", "calendar.family", "sensor.x"])).toEqual([
      "Grandparents visit",
      "Standup",
      "School pickup",
    ]);
    // The widget's calendar does not join the admin selection.
    expect(service.getStatus().entityIds).toEqual(["calendar.family"]);

    // Fetched at most once per refresh interval, and kept through outages.
    const workRequests = () =>
      ha.fetchImplementation.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).includes("calendar.work"),
      ).length;
    const before = workRequests();
    await titles(["calendar.work"]);
    expect(workRequests()).toBe(before);
    ha.down.add("calendar.work");
    clock.now = new Date(clock.now.getTime() + 301_000);
    expect(await titles(["calendar.work"])).toEqual(["Standup", "School pickup"]);
    expect(workRequests()).toBe(before + 1);

    // A calendar that was never fetched reports its error.
    ha.down.add("calendar.holidays");
    await expect(service.getEvents(["calendar.holidays"])).rejects.toThrow("503");

    // Date ranges, such as a whole month, are requested with their own window and cached.
    ha.down.clear();
    const monthStart = new Date("2026-10-31T00:00:00Z");
    const monthEnd = new Date("2026-12-02T00:00:00Z");
    const rangeRequests = () =>
      ha.fetchImplementation.mock.calls
        .map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
        .filter((url) => url.searchParams.get("start") === monthStart.toISOString());
    const month = await service.getEventsBetween(monthStart, monthEnd);
    expect(month.map((item) => item.title)).toEqual(["Grandparents visit", "School pickup"]);
    expect(rangeRequests().map((url) => url.searchParams.get("end"))).toEqual([
      monthEnd.toISOString(),
    ]);
    await service.getEventsBetween(monthStart, monthEnd);
    expect(rangeRequests()).toHaveLength(1);

    // An outage keeps the range's last events; a range never fetched fails.
    ha.down.add("*");
    clock.now = new Date(clock.now.getTime() + 301_000);
    expect(await service.getEventsBetween(monthStart, monthEnd)).toEqual(month);
    await expect(
      service.getEventsBetween(monthStart, new Date("2026-12-03T00:00:00Z")),
    ).rejects.toThrow("unavailable");
    database.close();
  });
});

describe("calendar event merging and labels", () => {
  const timeZone = "America/Chicago";
  const event = (changes: Partial<CalendarEvent>): CalendarEvent => ({
    title: "Event",
    start: "2026-11-06T15:00:00-06:00",
    end: "2026-11-06T16:00:00-06:00",
    allDay: false,
    location: null,
    ...changes,
  });
  const now = new Date("2026-11-06T18:00:00Z"); // Fri Nov 6, 12:00 PM CST

  it("merges calendars in time order and removes duplicates", () => {
    const merged = mergeCalendarEvents([
      [
        event({ title: "B" }),
        event({ title: "All day", allDay: true, start: "2026-11-06", end: "2026-11-07" }),
      ],
      [event({ title: "A", start: "2026-11-06T08:00:00-06:00" }), event({ title: "B" })],
    ]);
    expect(merged.map((item) => item.title)).toEqual(["All day", "A", "B"]);
  });

  it("fits titles by estimated pixel width", () => {
    const title = "🏎 FORMULA 1 MSC CRUISES GRANDE PRÊMIO DE SÃO PAULO 2026 - RACE";
    const fitted = fitToWidth(title, 520, 23, true);
    expect(fitted).toMatch(/…$/);
    expect(estimateTextWidth(fitted, 23, true)).toBeLessThanOrEqual(520);
    // Lowercase text of the same length is narrower, so more of it fits.
    const lower = fitToWidth(title.toLowerCase(), 520, 23, true);
    expect([...lower].length).toBeGreaterThan([...fitted].length);
    expect(fitToWidth("Grooming", 520, 23, true)).toBe("Grooming");
  });

  it.each([
    ["single timed event", event({}), "FRI, NOV 6", "3:00 PM"],
    [
      "single all-day event",
      event({ allDay: true, start: "2026-11-07", end: "2026-11-08" }),
      "SAT, NOV 7",
      "ALL DAY",
    ],
    [
      "all-day event in progress",
      event({ allDay: true, start: "2026-11-05", end: "2026-11-09" }),
      "FRI, NOV 6",
      "UNTIL NOV 8",
    ],
    [
      "all-day event ending today",
      event({ allDay: true, start: "2026-11-04", end: "2026-11-07" }),
      "FRI, NOV 6",
      "ENDS TODAY",
    ],
    [
      "future multi-day timed event",
      event({ start: "2026-11-07T22:00:00-06:00", end: "2026-11-09T02:00:00-06:00" }),
      "SAT, NOV 7",
      "10:00 PM → NOV 9",
    ],
    [
      "overnight event ending today",
      event({ start: "2026-11-05T22:00:00-06:00", end: "2026-11-06T14:00:00-06:00" }),
      "FRI, NOV 6",
      "UNTIL 2:00 PM",
    ],
    [
      "timed event ending at midnight",
      event({ start: "2026-11-06T20:00:00-06:00", end: "2026-11-07T00:00:00-06:00" }),
      "FRI, NOV 6",
      "8:00 PM",
    ],
  ])("labels a %s", (_name, item, day, time) => {
    expect(formatEventDay(item, timeZone, now).toUpperCase()).toBe(day);
    expect(formatEventTime(item, timeZone, now)).toBe(time);
  });
});
