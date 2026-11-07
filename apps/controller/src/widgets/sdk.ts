/**
 * Helpers for widget plugins. Plugins should import from this module only, so the plugin
 * contract stays small and stable.
 */
import { Type } from "@sinclair/typebox";

import { escapeXml } from "../artifacts/calendar-renderer.js";

export { Type } from "@sinclair/typebox";
export type { Static } from "@sinclair/typebox";
export { defineWidget } from "./types.js";
export type {
  CalendarEvent,
  EntityState,
  TodoTask,
  WidgetBox,
  WidgetDefinition,
  WidgetEnvironment,
  WidgetServices,
} from "./types.js";
export {
  escapeXml,
  estimateTextWidth,
  fitToWidth,
  formatEventDay,
  formatEventTime,
  truncate,
} from "../artifacts/calendar-renderer.js";
export { describeTask, formatDueDate } from "../artifacts/todo-renderer.js";

/** The font installed in the controller image. Other fonts render as missing glyphs. */
export const FONT_FAMILY = "DejaVu Sans, sans-serif";

/**
 * Schema for a Home Assistant entity ID such as `sensor.living_room_temperature`. The editor
 * suggests matching entities, limited to `domains` when given.
 */
export function EntityIdSchema(
  options: { title?: string; description?: string; domains?: string[] } = {},
) {
  return Type.String({
    pattern: "^[a-z_]+\\.[a-z0-9_]+$",
    maxLength: 255,
    title: options.title ?? "Entity ID",
    examples: ["sensor.living_room_temperature"],
    "x-suggest": "entity",
    ...(options.domains === undefined ? {} : { "x-domains": options.domains }),
    ...(options.description === undefined ? {} : { description: options.description }),
  });
}

/**
 * Schema for a list of Home Assistant entity IDs. The editor shows a checkbox for each entity
 * in `domains`.
 */
export function EntityIdListSchema(options: {
  title?: string;
  description?: string;
  domains: string[];
  maxItems?: number;
}) {
  return Type.Array(Type.String({ pattern: "^[a-z_]+\\.[a-z0-9_]+$", maxLength: 255 }), {
    maxItems: options.maxItems ?? 10,
    uniqueItems: true,
    title: options.title ?? "Entities",
    "x-suggest": "entity",
    "x-domains": options.domains,
    ...(options.description === undefined ? {} : { description: options.description }),
  });
}

/**
 * Schema for a list of Microsoft To Do list IDs. The editor shows a checkbox for each list of
 * the signed-in account.
 */
export function TodoListIdsSchema(options: { title?: string; description?: string } = {}) {
  return Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    maxItems: 20,
    uniqueItems: true,
    title: options.title ?? "Lists",
    "x-suggest": "todo-list",
    ...(options.description === undefined ? {} : { description: options.description }),
  });
}

/** Renders escaped text. `y` is the baseline. */
export function svgText(
  x: number,
  y: number,
  content: string,
  size: number,
  options: { bold?: boolean; anchor?: "start" | "middle" | "end" } = {},
): string {
  return `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}"${
    options.bold === true ? ' font-weight="700"' : ""
  }${options.anchor === undefined ? "" : ` text-anchor="${options.anchor}"`}>${escapeXml(
    content,
  )}</text>`;
}

/**
 * Approximate number of characters that fit in `width` pixels. DejaVu Sans averages about
 * 0.6 em per character, and about 0.65 em when bold.
 */
export function charsThatFit(width: number, fontSize: number, bold = false): number {
  return Math.max(1, Math.floor(width / (fontSize * (bold ? 0.65 : 0.6))));
}

/** Word-wraps text to `lineLength` characters, ending with an ellipsis past `maxLines`. */
export function wrapText(value: string, lineLength: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part !== "")) {
      const chunks = word.match(new RegExp(`.{1,${lineLength}}`, "g")) ?? [word];
      for (const chunk of chunks) {
        const candidate = current === "" ? chunk : `${current} ${chunk}`;
        if (candidate.length <= lineLength) {
          current = candidate;
        } else {
          lines.push(current);
          current = chunk;
        }
      }
    }
    lines.push(current);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1]!;
    kept[maxLines - 1] =
      last.length >= lineLength ? `${last.slice(0, lineLength - 1)}…` : `${last}…`;
    return kept;
  }
  return lines;
}

export function formatClock(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
    now,
  );
}

export function formatLongDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}
