import { describe, expect, it, vi } from "vitest";

import monthWidget, { eventsByDay, leadingBlanks, weatherIcon } from "./calendar_month/index.js";
import { createWidgetRegistry } from "./registry.js";
import { renderScreenSvg } from "./render.js";
import { createTestServices, renderWidgetForTest } from "./testing.js";
import type { CalendarEvent, WidgetServices } from "./types.js";

const event = (title: string, start: string, end: string, allDay = false): CalendarEvent => ({
  title,
  start,
  end,
  allDay,
  location: null,
});

describe("month calendar widget", () => {
  it("places events on every local day they cover", () => {
    const days = eventsByDay(
      [
        event("Trip", "2026-10-30", "2026-11-03", true),
        event("Overnight", "2026-11-05T22:00:00-06:00", "2026-11-06T02:00:00-06:00"),
        event("Ends at midnight", "2026-11-10T20:00:00-06:00", "2026-11-11T00:00:00-06:00"),
        event("Late UTC", "2026-11-12T03:00:00Z", "2026-11-12T04:00:00Z"),
        event("Next month", "2026-12-01", "2026-12-02", true),
      ],
      "2026-11",
      "America/Chicago",
    );
    expect(days).toEqual({
      "2026-11-01": ["Trip"],
      "2026-11-02": ["Trip"],
      "2026-11-05": ["Overnight"],
      "2026-11-06": ["Overnight"],
      "2026-11-10": ["Ends at midnight"],
      "2026-11-11": ["Late UTC"],
    });
  });

  it("lays out weeks from Monday or Sunday and maps weather codes", () => {
    // November 1, 2026 is a Sunday.
    expect(leadingBlanks("2026-11", "monday")).toBe(6);
    expect(leadingBlanks("2026-11", "sunday")).toBe(0);
    expect([0, 2, 45, 61, 73, 95, 7].map(weatherIcon)).toEqual([
      "sunny",
      "cloudy",
      "foggy",
      "rainy",
      "snowy",
      "stormy",
      "unknown",
    ]);
  });

  it("marks today, crosses out past days, and shows +n for hidden events", async () => {
    const busy = Array.from({ length: 6 }, (_, index) =>
      event(`Busy ${index}`, "2026-01-20", "2026-01-21", true),
    );
    const getEventsBetween = vi.fn(async () => [
      event("Team meeting", "2026-01-15T17:00:00Z", "2026-01-15T18:00:00Z"),
      ...busy,
    ]);
    const fetchJson = vi.fn<WidgetServices["fetchJson"]>(async () => ({
      daily: {
        time: ["2026-01-15", "2026-01-16"],
        weather_code: [0, 61],
        temperature_2m_max: [3.4, 5.6],
        temperature_2m_min: [-2.2, 1],
      },
    }));
    const services = createTestServices({
      calendar: { configured: true, getEvents: async () => [], getEventsBetween },
      fetchJson,
    });
    const result = await renderWidgetForTest(
      monthWidget,
      {
        calendars: ["calendar.family"],
        weekStart: "monday",
        maxEvents: 8,
        crossOutPastDays: true,
        weather: true,
      },
      services,
    );
    expect(result.hasError).toBe(false);
    const [start, end, ids] = getEventsBetween.mock.calls[0]! as unknown as [Date, Date, string[]];
    expect(start.toISOString()).toBe("2025-12-31T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-02-02T00:00:00.000Z");
    expect(ids).toEqual(["calendar.family"]);
    expect(fetchJson.mock.calls[0]![0]).toContain("latitude=41.88");

    expect(result.svg).toContain(">Jan<");
    expect(result.svg).toContain("Team meeting");
    expect(result.svg).toContain("3°/-2°");
    expect(result.svg).toMatch(/>\+\d+</);
    // Days 1–14 are crossed out with two dashed lines each.
    expect(result.svg.match(/stroke-dasharray="2 4"/g)).toHaveLength(28);
    // Today's number is white on a black bar.
    expect(result.svg).toMatch(/fill="white">15</);
  });

  it("keeps the calendar when the forecast is unavailable", async () => {
    const result = await renderWidgetForTest(
      monthWidget,
      { weekStart: "sunday", maxEvents: 4, crossOutPastDays: false, weather: true },
      createTestServices({
        fetchJson: async () => {
          throw new Error("offline");
        },
      }),
    );
    expect(result.hasError).toBe(false);
    expect(result.svg).not.toContain("°/");
    expect(result.svg).not.toContain("stroke-dasharray");
    expect(result.svg).toContain(">Sun<");
  });

  it("fills the whole screen when it is the only widget", async () => {
    const registry = await createWidgetRegistry();
    const services = createTestServices();
    const alone = await renderScreenSvg(
      { name: "Month", widgets: [{ type: "calendar_month", ...monthWidget.defaultConfig }] },
      registry,
      services,
    );
    expect(alone).not.toContain(">MONTH<");
    expect(alone).toContain('<svg x="0" y="0" width="800" height="480"');

    const withHeading = await renderScreenSvg(
      {
        name: "Month",
        widgets: [
          { type: "heading", text: "Family" },
          { type: "calendar_month", ...monthWidget.defaultConfig },
        ],
      },
      registry,
      services,
    );
    expect(withHeading).toContain(">MONTH<");
    expect(withHeading).not.toContain("DID NOT FIT");
  });
});
