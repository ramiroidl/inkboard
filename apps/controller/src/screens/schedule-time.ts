export interface LocalTime {
  /** 0 = Sunday through 6 = Saturday. */
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
}

export interface TimeWindow {
  days: readonly number[];
  start: string;
  end: string;
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

export function localTime(date: Date, timeZone: string): LocalTime {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(date)) {
    if (part.type === "weekday") {
      day = WEEKDAYS[part.value] ?? 0;
    } else if (part.type === "hour") {
      hour = Number(part.value) % 24;
    } else if (part.type === "minute") {
      minute = Number(part.value);
    }
  }
  return { day, minutes: hour * 60 + minute };
}

export function parseClock(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) {
    throw new Error(`Invalid time ${value}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A window whose end is not after its start crosses midnight. Its days refer to the day the
 * window starts, so a Friday 22:00–07:00 window also covers early Saturday.
 */
export function isWindowActive(window: TimeWindow, time: LocalTime): boolean {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start < end) {
    return window.days.includes(time.day) && time.minutes >= start && time.minutes < end;
  }
  return (
    (window.days.includes(time.day) && time.minutes >= start) ||
    (window.days.includes((time.day + 6) % 7) && time.minutes < end)
  );
}

/**
 * Returns the number of seconds until `state` first returns a different value, checking each
 * local minute boundary up to `maxMinutes` ahead. Stepping real instants keeps the result
 * correct across daylight-saving changes. Returns null when no change occurs in range.
 */
export function secondsUntilChange<T>(
  now: Date,
  maxMinutes: number,
  state: (instant: Date) => T,
): number | null {
  const current = state(now);
  const firstBoundary = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let step = 0; step < maxMinutes; step += 1) {
    const instant = new Date(firstBoundary + step * 60_000);
    if (state(instant) !== current) {
      return Math.ceil((instant.getTime() - now.getTime()) / 1000);
    }
  }
  return null;
}
