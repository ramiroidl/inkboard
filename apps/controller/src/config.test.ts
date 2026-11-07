import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("controller configuration", () => {
  it("requires an explicit device API token in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "INKBOARD_DEVICE_API_TOKEN is required in production",
    );
  });

  it("rejects short device API tokens", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        INKBOARD_DEVICE_API_TOKEN: "too-short",
      }),
    ).toThrow("INKBOARD_DEVICE_API_TOKEN must contain at least 32 characters");
  });

  it("requires the Home Assistant URL and token together", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
      }),
    ).toThrow("must be configured together");
    expect(() =>
      loadConfig({ NODE_ENV: "test", INKBOARD_HOME_ASSISTANT_CALENDAR: "calendar.family" }),
    ).toThrow("requires INKBOARD_HOME_ASSISTANT_URL");
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
        INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
        INKBOARD_HOME_ASSISTANT_CALENDAR: "calendar.family, sensor.nope",
      }),
    ).toThrow("got sensor.nope");
  });

  it("loads Home Assistant configuration with an optional calendar list", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123/",
      INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
      INKBOARD_HOME_ASSISTANT_CALENDAR: "calendar.family, calendar.work,calendar.family",
      INKBOARD_TIME_ZONE: "America/Chicago",
      INKBOARD_CALENDAR_LOOK_AHEAD_DAYS: "14",
      INKBOARD_CALENDAR_REFRESH_SECONDS: "600",
    });

    expect(config.homeAssistant).toEqual({
      baseUrl: "http://homeassistant.local:8123",
      token: "test-home-assistant-token",
      calendarEntities: ["calendar.family", "calendar.work"],
      timeZone: "America/Chicago",
      lookAheadDays: 14,
      refreshIntervalSeconds: 600,
    });

    const withoutCalendars = loadConfig({
      NODE_ENV: "test",
      INKBOARD_HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
      INKBOARD_HOME_ASSISTANT_TOKEN: "test-home-assistant-token",
    });
    expect(withoutCalendars.homeAssistant?.calendarEntities).toEqual([]);
  });
});
