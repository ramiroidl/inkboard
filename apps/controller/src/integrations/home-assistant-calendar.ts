import type { HomeAssistantConfig } from "../config.js";
import { homeAssistantApiUrl } from "./home-assistant-url.js";

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  /** Display name of the calendar the event came from, when known. */
  calendarName?: string;
}

interface HomeAssistantCalendarEvent {
  summary?: unknown;
  start?: unknown;
  end?: unknown;
  location?: unknown;
}

type FetchImplementation = typeof fetch;

function eventDateTime(value: unknown, fieldName: string): { value: string; allDay: boolean } {
  let candidate: unknown = value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    candidate = record.dateTime ?? record.date;
  }

  if (typeof candidate !== "string") {
    throw new Error(`Home Assistant calendar event is missing ${fieldName}`);
  }
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(candidate);
  const parsed = Date.parse(allDay ? `${candidate}T00:00:00Z` : candidate);
  if (Number.isNaN(parsed)) {
    throw new Error(`Home Assistant calendar event has an invalid ${fieldName}`);
  }
  return { value: candidate, allDay };
}

function normalizeEvent(value: unknown): CalendarEvent {
  if (typeof value !== "object" || value === null) {
    throw new Error("Home Assistant returned an invalid calendar event");
  }

  const event = value as HomeAssistantCalendarEvent;
  const start = eventDateTime(event.start, "start");
  const end = eventDateTime(event.end, "end");
  const title =
    typeof event.summary === "string" && event.summary.trim() !== ""
      ? event.summary.trim()
      : "Untitled event";

  return {
    title,
    start: start.value,
    end: end.value,
    allDay: start.allDay && end.allDay,
    location:
      typeof event.location === "string" && event.location.trim() !== ""
        ? event.location.trim()
        : null,
  };
}

export function eventSortTime(event: CalendarEvent): number {
  return Date.parse(event.allDay ? `${event.start}T00:00:00Z` : event.start);
}

export interface HomeAssistantCalendarInfo {
  entityId: string;
  name: string;
}

export class HomeAssistantCalendarClient {
  public constructor(
    private readonly config: HomeAssistantConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  /** Lists the calendar entities Home Assistant exposes. */
  public async listCalendars(): Promise<HomeAssistantCalendarInfo[]> {
    const payload = await this.getJson(homeAssistantApiUrl(this.config.baseUrl, "api/calendars"));
    if (!Array.isArray(payload)) {
      throw new Error("Home Assistant calendar list must be an array");
    }
    return payload
      .flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null) {
          return [];
        }
        const record = item as Record<string, unknown>;
        if (typeof record.entity_id !== "string") {
          return [];
        }
        return [
          {
            entityId: record.entity_id,
            name:
              typeof record.name === "string" && record.name.trim() !== ""
                ? record.name.trim()
                : record.entity_id,
          },
        ];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async getEvents(entityId: string, now: Date): Promise<CalendarEvent[]> {
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() + this.config.lookAheadDays);
    return this.getEventsBetween(entityId, now, end);
  }

  /** Events that overlap `start`–`end`, oldest first. */
  public async getEventsBetween(
    entityId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEvent[]> {
    const url = homeAssistantApiUrl(
      this.config.baseUrl,
      `api/calendars/${encodeURIComponent(entityId)}`,
    );
    url.searchParams.set("start", start.toISOString());
    url.searchParams.set("end", end.toISOString());

    const payload = await this.getJson(url);
    if (!Array.isArray(payload)) {
      throw new Error("Home Assistant calendar response must be an array");
    }

    return payload
      .map(normalizeEvent)
      .sort((left, right) => eventSortTime(left) - eventSortTime(right));
  }

  private async getJson(url: URL): Promise<unknown> {
    const response = await this.fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        Authorization: ["Bearer", this.config.token].join(" "),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Home Assistant calendar request returned HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  }
}
