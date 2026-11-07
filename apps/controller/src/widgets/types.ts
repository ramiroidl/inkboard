import type { TodoTask } from "@inkboard/contracts";
import type { Static, TObject } from "@sinclair/typebox";

import type { CalendarEvent } from "../integrations/home-assistant-calendar.js";
import type { EntityState } from "../integrations/home-assistant-states.js";

export type { CalendarEvent, EntityState, TodoTask };

/** Read-only values available while measuring and rendering. */
export interface WidgetEnvironment {
  /** IANA time zone configured with `INKBOARD_TIME_ZONE`. */
  timeZone: string;
  /** The render time. Use it instead of `new Date()` so output is reproducible. */
  now: Date;
  /**
   * Height in pixels left on the screen from the widget's top edge. List widgets can show
   * fewer rows so they fit instead of being left out. Undefined outside a screen layout.
   */
  availableHeight?: number;
}

/**
 * Data sources available in `load`. Plugins never receive credentials; every source caches
 * results and keeps serving the last good value when the upstream is unavailable.
 */
export interface WidgetServices extends WidgetEnvironment {
  homeAssistant: {
    /** False when no Home Assistant connection is configured. */
    configured: boolean;
    /** Returns null for unknown entities or when Home Assistant is not configured. */
    getState(entityId: string): Promise<EntityState | null>;
  };
  calendar: {
    /** False when Home Assistant is not connected. */
    configured: boolean;
    /**
     * Upcoming events, oldest first. Without `entityIds`, events come from the calendars
     * selected on the admin page; otherwise from the given `calendar.*` entities.
     */
    getEvents(entityIds?: string[]): Promise<CalendarEvent[]>;
  };
  todo: {
    /** False until Microsoft To Do is signed in. */
    configured: boolean;
    /**
     * Incomplete tasks by due date then importance. Without `listIds`, tasks come from the
     * lists selected on the admin page; otherwise from the given Microsoft To Do lists.
     */
    getTasks(listIds?: string[]): Promise<TodoTask[]>;
  };
  /**
   * GETs JSON from an http(s) URL with a 10 second timeout and a response limit of 256 KB.
   * Responses are cached for `ttlSeconds` (default 300). Throws when the request fails and
   * no earlier response is cached.
   */
  fetchJson(url: string, options?: { ttlSeconds?: number }): Promise<unknown>;
}

/** The area a widget draws into. Coordinates are local: the top-left corner is (0, 0). */
export interface WidgetBox {
  width: number;
  height: number;
}

/**
 * The contract every widget plugin implements. Export one definition as the default export
 * of `apps/controller/src/widgets/<type>/index.ts`; the registry discovers it at startup.
 *
 * Lifecycle for each render: settings are validated against `configSchema`, `load` fetches
 * data, `height` measures the widget, and `render` returns an SVG fragment that is clipped
 * to its box. Output must be black and white with no scripts, links, or external images.
 */
export interface WidgetDefinition<TSchema extends TObject = TObject, TData = unknown> {
  /** Unique identifier stored in screens. Lowercase letters, digits, and underscores. */
  type: string;
  /** Name shown in the screen editor. */
  name: string;
  description: string;
  /**
   * Settings schema. Each property's `title`, `description`, `examples`, and limits drive
   * the generated editor form. Do not include a `type` property.
   */
  configSchema: TSchema;
  /** Settings used when the widget is added to a screen. Must satisfy `configSchema`. */
  defaultConfig: Static<TSchema>;
  /** Consecutive widgets of this type share a row of up to this many cells. Default 1. */
  maxPerRow?: number;
  /** Optional data loading. Errors are shown in place of the widget. */
  load?(config: Static<TSchema>, services: WidgetServices): Promise<TData>;
  /** Height in pixels the widget needs at the given width. */
  height(
    config: Static<TSchema>,
    data: TData,
    width: number,
    environment: WidgetEnvironment,
  ): number;
  /** SVG fragment drawn in local coordinates within `box`. */
  render(
    config: Static<TSchema>,
    data: TData,
    box: WidgetBox,
    environment: WidgetEnvironment,
  ): string;
}

/** Identity helper that infers settings and data types for a widget definition. */
export function defineWidget<TSchema extends TObject, TData = undefined>(
  definition: WidgetDefinition<TSchema, TData>,
): WidgetDefinition<TSchema, TData> {
  return definition;
}
