import type { CalendarEvent } from "../integrations/home-assistant-calendar.js";

const DISPLAY_WIDTH = 800;
const DISPLAY_HEIGHT = 480;
const MAX_VISIBLE_EVENTS = 6;
/** Event rows start below the date heading and end just above the footer rule at 452. */
const ROWS_TOP = 74;
const ROW_HEIGHT = 62;

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, maximumLength - 1).trimEnd()}…`;
}

/**
 * Approximate rendered width in pixels of DejaVu Sans text. Capitals and digits are much
 * wider than lowercase letters, so counting characters alone lets uppercase titles overflow.
 */
export function estimateTextWidth(value: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const character of value) {
    if (character === " ") {
      em += bold ? 0.35 : 0.32;
    } else if (/[A-Z]/.test(character)) {
      em += bold ? 0.78 : 0.72;
    } else if (/[0-9]/.test(character)) {
      em += bold ? 0.7 : 0.64;
    } else if (/[a-z]/.test(character)) {
      em += bold ? 0.64 : 0.58;
    } else if (/[\p{L}\p{N}]/u.test(character)) {
      // Accented and non-Latin letters: assume capital width to stay inside the box.
      em += character.codePointAt(0)! > 0x2e80 ? 1 : bold ? 0.78 : 0.72;
    } else if (/\p{Extended_Pictographic}/u.test(character)) {
      em += 1.05;
    } else if (character === "\u200d" || character === "\ufe0f") {
      // Zero-width joiners and emoji variation selectors.
    } else {
      em += 0.45;
    }
  }
  return em * fontSize;
}

/** Truncates text with an ellipsis so it fits within `width` pixels. */
export function fitToWidth(value: string, width: number, fontSize: number, bold = false): string {
  if (estimateTextWidth(value, fontSize, bold) <= width) {
    return value;
  }
  const characters = [...value];
  const ellipsis = estimateTextWidth("…", fontSize, bold);
  let fitted = "";
  for (const character of characters) {
    if (estimateTextWidth(fitted + character, fontSize, bold) + ellipsis > width) {
      break;
    }
    fitted += character;
  }
  return `${fitted.trimEnd()}…`;
}

function allDayDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid all-day calendar date: ${value}`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar date as `YYYY-MM-DD` in the given time zone. */
export function localDateKey(date: Date, timeZone: string): string {
  let formatter = dateKeyFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateKeyFormatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

function addDays(key: string, days: number): string {
  const date = allDayDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First and last local dates an event covers. All-day end dates are exclusive. */
export function eventDateRange(
  event: CalendarEvent,
  timeZone: string,
): { first: string; last: string } {
  if (event.allDay) {
    const last = addDays(event.end, -1);
    return { first: event.start, last: last < event.start ? event.start : last };
  }
  const first = localDateKey(new Date(event.start), timeZone);
  const last = localDateKey(new Date(Date.parse(event.end) - 1), timeZone);
  return { first, last: last < first ? first : last };
}

function formatDateKey(key: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(allDayDate(key));
}

function formatClockTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * The day an event appears under: its first day, or today for an event already in
 * progress.
 */
export function formatEventDay(event: CalendarEvent, timeZone: string, now: Date): string {
  const { first } = eventDateRange(event, timeZone);
  const today = localDateKey(now, timeZone);
  return formatDateKey(first < today ? today : first, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Time line for an event, including the end date of multi-day events. */
export function formatEventTime(event: CalendarEvent, timeZone: string, now: Date): string {
  const { first, last } = eventDateRange(event, timeZone);
  const today = localDateKey(now, timeZone);
  const shortDate = (key: string) =>
    formatDateKey(key, { month: "short", day: "numeric" }).toUpperCase();
  const started = first < today;

  if (first === last) {
    return event.allDay ? "ALL DAY" : formatClockTime(event.start, timeZone);
  }
  if (event.allDay) {
    return last === today ? "ENDS TODAY" : `UNTIL ${shortDate(last)}`;
  }
  if (started) {
    return last === today
      ? `UNTIL ${formatClockTime(event.end, timeZone)}`
      : `UNTIL ${shortDate(last)}`;
  }
  return `${formatClockTime(event.start, timeZone)} → ${shortDate(last)}`;
}

function eventRows(events: CalendarEvent[], timeZone: string, now: Date): string {
  if (events.length === 0) {
    return `
      <rect x="34" y="96" width="732" height="336" fill="none" stroke="black" stroke-width="2"/>
      <text x="400" y="252" text-anchor="middle" font-family="DejaVu Sans, sans-serif"
        font-size="34" font-weight="700">NO UPCOMING EVENTS</text>
      <text x="400" y="298" text-anchor="middle" font-family="DejaVu Sans, sans-serif"
        font-size="21">Your calendar is clear.</text>
    `;
  }

  const showCalendar =
    new Set(events.map((event) => event.calendarName).filter((name) => name !== undefined)).size >
    1;
  return events
    .slice(0, MAX_VISIBLE_EVENTS)
    .map((event, index) => {
      const y = ROWS_TOP + index * ROW_HEIGHT;
      const detail = [showCalendar ? event.calendarName : undefined, event.location ?? undefined]
        .filter((part): part is string => part !== undefined && part !== "")
        .join(" · ");
      const location =
        detail === ""
          ? ""
          : `<text x="232" y="${y + 45}" font-family="DejaVu Sans, sans-serif" font-size="15">${escapeXml(
              fitToWidth(detail, 520, 15),
            )}</text>`;
      return `
        ${index === 0 ? "" : `<line x1="34" y1="${y}" x2="766" y2="${y}" stroke="black" stroke-width="1"/>`}
        <text x="48" y="${y + 25}" font-family="DejaVu Sans, sans-serif" font-size="18"
          font-weight="700">${escapeXml(formatEventDay(event, timeZone, now).toUpperCase())}</text>
        <text x="48" y="${y + 48}" font-family="DejaVu Sans, sans-serif" font-size="15">
          ${escapeXml(formatEventTime(event, timeZone, now))}
        </text>
        <line x1="208" y1="${y + 10}" x2="208" y2="${y + 52}" stroke="black" stroke-width="3"/>
        <text x="232" y="${y + 27}" font-family="DejaVu Sans, sans-serif" font-size="23"
          font-weight="700">${escapeXml(fitToWidth(event.title, 520, 23, true))}</text>
        ${location}
      `;
    })
    .join("");
}

export function calendarSvg(
  events: CalendarEvent[],
  options: {
    calendarNames: string[];
    timeZone: string;
    lookAheadDays: number;
    now: Date;
  },
): string {
  const currentDate = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(options.now);
  const currentYear = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone,
    year: "numeric",
  }).format(options.now);
  const hiddenCount = Math.max(0, events.length - MAX_VISIBLE_EVENTS);

  return `
    <svg width="${DISPLAY_WIDTH}" height="${DISPLAY_HEIGHT}" viewBox="0 0 ${DISPLAY_WIDTH} ${DISPLAY_HEIGHT}"
      xmlns="http://www.w3.org/2000/svg">
      <rect width="${DISPLAY_WIDTH}" height="${DISPLAY_HEIGHT}" fill="white"/>
      <rect x="1" y="1" width="798" height="478" fill="none" stroke="black" stroke-width="2"/>
      <text x="34" y="54" font-family="DejaVu Sans, sans-serif" font-size="38"
        font-weight="700">${escapeXml(currentDate)}</text>
      <text x="766" y="54" text-anchor="end" font-family="DejaVu Sans, sans-serif"
        font-size="38">${escapeXml(currentYear)}</text>
      <line x1="34" y1="70" x2="766" y2="70" stroke="black" stroke-width="4"/>
      ${eventRows(events, options.timeZone, options.now)}
      <line x1="34" y1="452" x2="766" y2="452" stroke="black" stroke-width="2"/>
      <text x="34" y="472" font-family="DejaVu Sans, sans-serif" font-size="14">
        ${escapeXml(fitToWidth(options.calendarNames.join(" + ").toUpperCase(), 420, 14))} · NEXT ${options.lookAheadDays} DAYS
      </text>
      <text x="766" y="472" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="14">
        ${hiddenCount === 0 ? `${events.length} EVENT${events.length === 1 ? "" : "S"}` : `+${hiddenCount} MORE`}
      </text>
    </svg>
  `;
}
