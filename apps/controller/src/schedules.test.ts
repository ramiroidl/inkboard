import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { isWindowActive, localTime, secondsUntilChange } from "./screens/schedule-time.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Local America/Chicago wall time on the test day (CDT, UTC-5). */
const at = (time: string, date = "2026-10-31", offset = "-05:00") =>
  new Date(`${date}T${time}:00${offset}`);

async function createApp() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "inkboard-schedules-"));
  directories.push(dataDirectory);
  const config = loadConfig({
    NODE_ENV: "test",
    INKBOARD_DATA_DIR: dataDirectory,
    INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
    INKBOARD_LOG_LEVEL: "silent",
    INKBOARD_TIME_ZONE: "America/Chicago",
  });
  const clock = { now: at("10:00") };
  const app = await buildApp(config, { now: () => clock.now });
  const authorization = ["Bearer", config.deviceApiToken].join(" ");

  const checkIn = async (buttonEvent = "none", displayResult = "displayed") => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/device/check-in",
      headers: { authorization },
      payload: {
        deviceId: "inkboard-og",
        firmwareVersion: "0.4.0",
        model: "seeed-ee04-800x480-mono",
        width: 800,
        height: 480,
        wakeReason: "timer",
        buttonEvent,
        displayResult,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ screenId: string; nextRefreshSeconds: number }>();
  };
  const image = (etag?: string) =>
    app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp?device=inkboard-og",
      headers: { authorization, ...(etag === undefined ? {} : { "if-none-match": etag }) },
    });
  const screenNow = async () => (await image()).headers["x-screen-id"];

  return { app, clock, checkIn, image, screenNow };
}

describe("schedule windows", () => {
  it("handles same-day and overnight windows", () => {
    const daytime = { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" };
    expect(isWindowActive(daytime, { day: 1, minutes: 8 * 60 })).toBe(true);
    expect(isWindowActive(daytime, { day: 1, minutes: 17 * 60 })).toBe(false);
    expect(isWindowActive(daytime, { day: 6, minutes: 9 * 60 })).toBe(false);

    const friday = { days: [5], start: "22:00", end: "07:00" };
    expect(isWindowActive(friday, { day: 5, minutes: 23 * 60 })).toBe(true);
    expect(isWindowActive(friday, { day: 6, minutes: 3 * 60 })).toBe(true);
    expect(isWindowActive(friday, { day: 6, minutes: 23 * 60 })).toBe(false);
    expect(isWindowActive(friday, { day: 5, minutes: 3 * 60 })).toBe(false);
  });

  it("reads local weekday and time in the configured zone", () => {
    expect(localTime(at("10:00"), "America/Chicago")).toEqual({ day: 6, minutes: 600 });
    expect(localTime(at("00:30", "2026-11-01"), "America/Chicago")).toEqual({
      day: 0,
      minutes: 30,
    });
  });

  it("measures real elapsed time across the daylight-saving change", () => {
    const quiet = { days: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "07:00" };
    const seconds = secondsUntilChange(at("23:00"), 24 * 60, (instant) =>
      isWindowActive(quiet, localTime(instant, "America/Chicago")),
    );
    // 23:00 CDT to 07:00 CST is nine real hours because clocks fall back at 02:00.
    expect(seconds).toBe(9 * 3600);
  });
});

describe("screen schedules", () => {
  it("applies rules, honors manual choices, and restores the previous screen", async () => {
    const { app, clock, checkIn, screenNow } = await createApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens",
      payload: { name: "Morning", widgets: [{ type: "heading", text: "Good morning" }] },
    });
    const morning = created.json<{ id: string }>().id;
    expect((await checkIn()).screenId).toBe("orientation");

    for (const rules of [
      [{ screenId: "missing", days: [6], start: "10:30", end: "11:00" }],
      [{ screenId: morning, days: [6], start: "10:30", end: "10:30" }],
      [{ screenId: morning, days: [6], start: "25:00", end: "11:00" }],
      [{ screenId: morning, days: [], start: "10:30", end: "11:00" }],
      [{ screenId: morning, days: [7], start: "10:30", end: "11:00" }],
    ]) {
      const invalid = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/schedules",
        payload: { rules },
      });
      expect(invalid.statusCode).toBe(400);
    }

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/schedules",
      payload: { rules: [{ screenId: morning, days: [6, 6], start: "10:30", end: "11:00" }] },
    });
    expect(saved.statusCode).toBe(200);
    const [rule] = saved.json<{ rules: { id: string; days: number[] }[] }>().rules;
    expect(rule!.id).toMatch(/^rule_[a-f0-9]{8}$/);
    expect(rule!.days).toEqual([6]);

    // Before the window: default cadence, then wake right after the window opens.
    expect(await screenNow()).toBe("orientation");
    expect((await checkIn()).nextRefreshSeconds).toBe(900);
    clock.now = at("10:20");
    expect((await checkIn()).nextRefreshSeconds).toBe(605);

    clock.now = at("10:30");
    expect(await screenNow()).toBe(morning);
    const state = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(state.json()).toMatchObject({
      scheduleState: { activeRuleId: rule!.id, quietHoursActive: false },
      timeZone: "America/Chicago",
    });

    // A button press holds the chosen screen for one interval, then the rule resumes.
    clock.now = at("10:35");
    expect((await checkIn("next", "button")).screenId).toBe("orientation");
    clock.now = at("10:45");
    expect(await screenNow()).toBe("orientation");
    clock.now = at("10:51");
    expect(await screenNow()).toBe(morning);

    // The pre-schedule screen returns when the window closes.
    clock.now = at("11:00");
    expect(await screenNow()).toBe("orientation");

    // Deleting a screen removes its rules.
    await app.inject({ method: "DELETE", url: `/api/v1/admin/screens/${morning}` });
    const after = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
    expect(after.json()).toMatchObject({ schedules: [] });

    await app.close();
  });

  it("freezes the display during quiet hours unless a button is pressed", async () => {
    const { app, clock, checkIn, image } = await createApp();
    await checkIn();

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/quiet-hours",
      payload: { enabled: true, start: "22:00", end: "22:00" },
    });
    expect(invalid.statusCode).toBe(400);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/quiet-hours",
      payload: { enabled: true, start: "22:00", end: "07:00" },
    });
    expect(saved.json()).toEqual({ enabled: true, start: "22:00", end: "07:00" });

    clock.now = at("21:50");
    expect((await checkIn()).nextRefreshSeconds).toBe(605);

    clock.now = at("23:00");
    const frozen = await image('"sha256:stale"');
    expect(frozen.statusCode).toBe(304);
    expect(frozen.headers["x-quiet-hours"]).toBe("1");
    // A device without an image still gets one.
    expect((await image()).statusCode).toBe(200);
    // Firmware sends an empty header when its panel shows no known image.
    expect((await image("")).statusCode).toBe(200);
    // Sleep until quiet hours end: nine real hours across the daylight-saving change.
    expect((await checkIn()).nextRefreshSeconds).toBe(9 * 3600 + 5);

    // A button press lets the next image request through.
    await checkIn("refresh", "button");
    expect((await image('"sha256:stale"')).statusCode).toBe(200);
    clock.now = at("23:05");
    expect((await image('"sha256:stale"')).statusCode).toBe(304);

    clock.now = at("07:00", "2026-11-01", "-06:00");
    expect((await image('"sha256:stale"')).statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/quiet-hours",
      payload: { enabled: false, start: "22:00", end: "07:00" },
    });
    clock.now = at("23:30");
    expect((await image('"sha256:stale"')).statusCode).toBe(200);

    await app.close();
  });
});
