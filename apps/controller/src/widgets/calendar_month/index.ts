import {
  defineWidget,
  EntityIdListSchema,
  escapeXml,
  estimateTextWidth,
  eventDateRange,
  fitToWidth,
  localDateKey,
  svgText,
  Type,
  type CalendarEvent,
  type WidgetServices,
} from "../sdk.js";

const FONT = "DejaVu Sans, sans-serif";
const GAP = 4;

/** Font sizes and spacing for each text size choice. */
const TEXT_SIZES = {
  normal: { event: 12, line: 14, day: 16, bar: 20, header: 14, weather: 10 },
  large: { event: 14, line: 16, day: 18, bar: 22, header: 16, weather: 11 },
  extraLarge: { event: 16, line: 19, day: 20, bar: 24, header: 17, weather: 12 },
} as const;

/** Width of the left column for each month label choice. */
const GUTTERS = { header: 38, vertical: 44, none: 0 } as const;

export interface DayWeather {
  icon: "sunny" | "cloudy" | "foggy" | "rainy" | "snowy" | "stormy" | "unknown";
  max: number;
  min: number;
}

export interface MonthData {
  /** Local date of today, `YYYY-MM-DD`. */
  today: string;
  /** `YYYY-MM` of the month shown. */
  month: string;
  /** Event titles per local date, in time order. Null when calendars are unavailable. */
  days: Record<string, string[]> | null;
  weather: Record<string, DayWeather>;
}

function keyToDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function addDays(key: string, days: number): string {
  const date = keyToDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/** Leading blank cells before the 1st, for weeks starting on Monday or Sunday. */
export function leadingBlanks(month: string, weekStart: "monday" | "sunday"): number {
  const weekday = keyToDate(`${month}-01`).getUTCDay();
  return weekStart === "monday" ? (weekday + 6) % 7 : weekday;
}

/** Titles per local date of `month`. Multi-day events appear on every day they cover. */
export function eventsByDay(
  events: CalendarEvent[],
  month: string,
  timeZone: string,
): Record<string, string[]> {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const days: Record<string, string[]> = {};
  for (const event of events) {
    const range = eventDateRange(event, timeZone);
    let day = range.first < first ? first : range.first;
    const end = range.last > last ? last : range.last;
    while (day <= end) {
      (days[day] ??= []).push(event.title);
      day = addDays(day, 1);
    }
  }
  return days;
}

/** Open-Meteo WMO weather codes to the icons drawn here. */
export function weatherIcon(code: number): DayWeather["icon"] {
  if (code === 0 || code === 1) return "sunny";
  if (code === 2 || code === 3) return "cloudy";
  if (code === 45 || code === 48) return "foggy";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rainy";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snowy";
  if (code >= 95 && code <= 99) return "stormy";
  return "unknown";
}

/** Seven days of forecast from Home Assistant's home location, or nothing on any error. */
async function loadWeather(services: WidgetServices): Promise<Record<string, DayWeather>> {
  try {
    const location = await services.homeAssistant.getLocation();
    if (location === null) {
      return {};
    }
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    // Two decimals (about 1 km) is plenty for a forecast and shares less of the location.
    url.searchParams.set("latitude", location.latitude.toFixed(2));
    url.searchParams.set("longitude", location.longitude.toFixed(2));
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    url.searchParams.set("timezone", services.timeZone);
    url.searchParams.set("forecast_days", "7");
    url.searchParams.set("temperature_unit", location.temperatureUnit);
    const body = (await services.fetchJson(url.toString(), { ttlSeconds: 3600 })) as {
      daily?: Record<string, unknown>;
    };
    const daily = body.daily ?? {};
    const dates = daily.time;
    const codes = daily.weather_code;
    const highs = daily.temperature_2m_max;
    const lows = daily.temperature_2m_min;
    if (![dates, codes, highs, lows].every(Array.isArray)) {
      return {};
    }
    const weather: Record<string, DayWeather> = {};
    (dates as unknown[]).forEach((date, index) => {
      const code = (codes as unknown[])[index];
      const max = (highs as unknown[])[index];
      const min = (lows as unknown[])[index];
      if (
        typeof date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        typeof code === "number" &&
        typeof max === "number" &&
        typeof min === "number"
      ) {
        weather[date] = { icon: weatherIcon(code), max: Math.round(max), min: Math.round(min) };
      }
    });
    return weather;
  } catch {
    return {};
  }
}

const CLOUD = "M4.5 12 H12 A3 3 0 0 0 12 6 A4.2 4.2 0 0 0 4 6.5 A2.8 2.8 0 0 0 4.5 12 Z";

/** A 16×16 monochrome weather icon. */
function iconSvg(icon: DayWeather["icon"], x: number, y: number, color: string): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round"`;
  const raisedCloud = `<path d="${CLOUD}" transform="translate(0 -3)" ${stroke}/>`;
  const shapes: Record<DayWeather["icon"], string> = {
    sunny:
      `<circle cx="8" cy="8" r="3" ${stroke}/>` +
      [0, 45, 90, 135, 180, 225, 270, 315]
        .map(
          (angle) =>
            `<line x1="8" y1="2" x2="8" y2="3.4" transform="rotate(${angle} 8 8)" ${stroke}/>`,
        )
        .join(""),
    cloudy: `<path d="${CLOUD}" ${stroke}/>`,
    foggy: [5, 8, 11]
      .map((ly) => `<line x1="2" y1="${ly}" x2="14" y2="${ly}" ${stroke}/>`)
      .join(""),
    rainy:
      raisedCloud +
      [5, 8, 11]
        .map((lx) => `<line x1="${lx}" y1="11" x2="${lx - 1}" y2="14" ${stroke}/>`)
        .join(""),
    snowy:
      raisedCloud +
      [5, 8, 11].map((cx) => `<circle cx="${cx}" cy="12.5" r="0.9" fill="${color}"/>`).join(""),
    stormy: raisedCloud + `<polyline points="8.5,9 6.5,12.5 9,12.5 7,15.5" ${stroke}/>`,
    unknown: `<text x="8" y="12" font-family="${FONT}" font-size="11" text-anchor="middle" fill="${color}">?</text>`,
  };
  return `<g transform="translate(${x} ${y})">${shapes[icon]}</g>`;
}

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  options: { bold?: boolean; anchor?: "start" | "middle" | "end"; color?: string } = {},
): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${
    options.bold === true ? ' font-weight="700"' : ""
  }${options.anchor === undefined ? "" : ` text-anchor="${options.anchor}"`} fill="${
    options.color ?? "black"
  }">${escapeXml(value)}</text>`;
}

export default defineWidget({
  type: "calendar_month",
  name: "Month calendar",
  description:
    "The whole month with event names, today highlighted, and past days crossed out. Fills the screen when it is the only widget.",
  fullScreen: true,
  configSchema: Type.Object({
    calendars: Type.Optional(
      EntityIdListSchema({
        title: "Calendars",
        description: "Leave all unticked to use the calendars chosen in the Home Assistant card.",
        domains: ["calendar"],
      }),
    ),
    weekStart: Type.Union(
      [Type.Literal("monday", { title: "Monday" }), Type.Literal("sunday", { title: "Sunday" })],
      { title: "Week starts on" },
    ),
    monthLabel: Type.Optional(
      Type.Union(
        [
          Type.Literal("header", { title: "Short name before the weekdays" }),
          Type.Literal("vertical", { title: "Full name down the left side" }),
          Type.Literal("none", { title: "None" }),
        ],
        { title: "Month name" },
      ),
    ),
    textSize: Type.Optional(
      Type.Union(
        [
          Type.Literal("normal", { title: "Normal" }),
          Type.Literal("large", { title: "Large" }),
          Type.Literal("extraLarge", { title: "Extra large" }),
        ],
        {
          title: "Text size",
          description: "Larger text shows fewer events per day.",
        },
      ),
    ),
    maxEvents: Type.Integer({
      minimum: 1,
      maximum: 8,
      title: "Events per day",
      description: "Fewer are shown when they do not fit; the last line shows +n for the rest.",
    }),
    crossOutPastDays: Type.Boolean({ title: "Cross out past days" }),
    weather: Type.Boolean({
      title: "Show weather",
      description:
        "Seven-day forecast from Open-Meteo for Home Assistant's home location (rounded to about 1 km).",
    }),
  }),
  defaultConfig: {
    calendars: [],
    weekStart: "monday",
    monthLabel: "header",
    textSize: "normal",
    maxEvents: 4,
    crossOutPastDays: true,
    weather: false,
  },
  load: async (config, services): Promise<MonthData> => {
    const today = localDateKey(services.now, services.timeZone);
    const month = today.slice(0, 7);
    const first = `${month}-01`;
    // Fetch a day beyond each end so time zone offsets cannot drop events.
    const start = keyToDate(addDays(first, -1));
    const end = keyToDate(addDays(first, daysInMonth(month) + 1));
    const [events, weather] = await Promise.all([
      services.calendar.configured
        ? services.calendar.getEventsBetween(start, end, config.calendars)
        : Promise.resolve(null),
      config.weather ? loadWeather(services) : Promise.resolve({}),
    ]);
    return {
      today,
      month,
      days: events === null ? null : eventsByDay(events, month, services.timeZone),
      weather,
    };
  },
  // Take the rest of the screen; below 200 pixels the grid is unreadable, so it is left out.
  height: (_config, _data, _width, { availableHeight }) => Math.max(200, availableHeight ?? 400),
  render: (config, data, box) => {
    const parts: string[] = [];
    const size = TEXT_SIZES[config.textSize ?? "normal"];
    const monthLabel = config.monthLabel ?? "header";
    const gutter = GUTTERS[monthLabel];
    const pad = box.width >= 800 ? 6 : 0;
    const columnWidth = (box.width - pad * 2 - gutter - GAP * 6) / 7;
    const blanks = leadingBlanks(data.month, config.weekStart);
    const count = daysInMonth(data.month);
    const rows = Math.ceil((blanks + count) / 7);
    const headerHeight = size.header + 12;
    const gridTop = pad + headerHeight;
    const gridHeight = box.height - gridTop - pad;
    const rowHeight = (gridHeight - GAP * (rows - 1)) / rows;
    const left = pad + gutter;
    const headerBaseline = pad + size.header + 4;

    const monthDate = keyToDate(`${data.month}-01`);
    if (monthLabel === "header") {
      const monthName = new Intl.DateTimeFormat("en-US", {
        month: "short",
        timeZone: "UTC",
      }).format(monthDate);
      parts.push(text(pad + 2, headerBaseline, monthName, size.header + 1, { bold: true }));
    } else if (monthLabel === "vertical") {
      // The full month name reads bottom to top along the left column.
      const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
        .format(monthDate)
        .toUpperCase();
      const fontSize = Math.min(
        34,
        Math.floor(
          (gridHeight - 8) / (estimateTextWidth(monthName, 1, true) + monthName.length * 0.15),
        ),
      );
      const centerX = pad + gutter / 2;
      const centerY = gridTop + gridHeight / 2;
      parts.push(
        `<text x="${centerX}" y="${centerY + fontSize * 0.35}" transform="rotate(-90 ${centerX} ${centerY})" font-family="${FONT}" font-size="${fontSize}" font-weight="700" letter-spacing="${(fontSize * 0.15).toFixed(1)}" text-anchor="middle">${escapeXml(monthName)}</text>`,
      );
    }
    const names =
      config.weekStart === "monday"
        ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    names.forEach((name, index) => {
      parts.push(
        text(
          left + index * (columnWidth + GAP) + columnWidth / 2,
          headerBaseline,
          name,
          size.header,
          {
            anchor: "middle",
          },
        ),
      );
    });

    if (data.days === null) {
      parts.push(text(left, gridTop + 30, "Home Assistant not configured", 18));
    }

    for (let dayNumber = 1; dayNumber <= count; dayNumber += 1) {
      const cell = blanks + dayNumber - 1;
      const x = left + (cell % 7) * (columnWidth + GAP);
      const y = gridTop + Math.floor(cell / 7) * (rowHeight + GAP);
      const key = `${data.month}-${String(dayNumber).padStart(2, "0")}`;
      const isToday = key === data.today;
      const weather = data.weather[key];

      parts.push(
        `<rect x="${x + 0.5}" y="${y + 0.5}" width="${columnWidth - 1}" height="${rowHeight - 1}" fill="none" stroke="black" stroke-width="1"/>`,
      );
      if (isToday) {
        parts.push(
          `<rect x="${x}" y="${y}" width="${columnWidth}" height="${size.bar}" fill="black"/>`,
        );
      }
      const ink = isToday ? "white" : "black";
      parts.push(
        text(x + 4, y + size.bar - 4, String(dayNumber), size.day, { bold: isToday, color: ink }),
      );
      if (weather !== undefined) {
        // Narrow cells drop the icon, then the temperatures, rather than overlap the day.
        const label = `${weather.max}°/${weather.min}°`;
        const labelWidth = estimateTextWidth(label, size.weather);
        const dayWidth = estimateTextWidth(String(dayNumber), size.day, isToday) + 10;
        const room = columnWidth - dayWidth - 3;
        if (labelWidth <= room) {
          parts.push(
            text(x + columnWidth - 3, y + size.bar - 6, label, size.weather, {
              anchor: "end",
              color: ink,
            }),
          );
        }
        if (labelWidth + 17 <= room) {
          parts.push(
            iconSvg(
              weather.icon,
              x + columnWidth - 3 - labelWidth - 17,
              y + (size.bar - 16) / 2,
              ink,
            ),
          );
        }
      }

      const titles = data.days?.[key] ?? [];
      const capacity = Math.max(
        0,
        Math.min(config.maxEvents, Math.floor((rowHeight - size.bar - 4) / size.line)),
      );
      const firstLine = y + size.bar + size.event;
      if (capacity === 1 && titles.length > 1) {
        // One line only: the first event, then the count of the others.
        const more = ` +${titles.length - 1}`;
        const moreWidth = estimateTextWidth(more, size.event, true);
        parts.push(
          svgText(
            x + 4,
            firstLine,
            fitToWidth(titles[0]!, columnWidth - 8 - moreWidth, size.event),
            size.event,
          ),
          svgText(x + columnWidth - 4, firstLine, more.trim(), size.event, {
            bold: true,
            anchor: "end",
          }),
        );
      } else {
        const shown = titles.length > capacity ? Math.max(0, capacity - 1) : titles.length;
        titles.slice(0, shown).forEach((title, index) => {
          parts.push(
            svgText(
              x + 4,
              firstLine + index * size.line,
              fitToWidth(title, columnWidth - 8, size.event),
              size.event,
            ),
          );
        });
        if (titles.length > shown && capacity > 0) {
          parts.push(
            svgText(x + 4, firstLine + shown * size.line, `+${titles.length - shown}`, size.event, {
              bold: true,
            }),
          );
        }
      }

      if (config.crossOutPastDays && key < data.today) {
        // Sparse dashes read as light gray on a black-and-white panel.
        const dash = 'stroke="black" stroke-width="1" stroke-dasharray="2 4"';
        parts.push(
          `<line x1="${x + 2}" y1="${y + 2}" x2="${x + columnWidth - 2}" y2="${y + rowHeight - 2}" ${dash}/>`,
          `<line x1="${x + columnWidth - 2}" y1="${y + 2}" x2="${x + 2}" y2="${y + rowHeight - 2}" ${dash}/>`,
        );
      }
    }
    return parts.join("");
  },
});
