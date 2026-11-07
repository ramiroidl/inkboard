/**
 * Test helpers for widget plugins. A plugin test can render its widget exactly as the
 * controller does, with stubbed data sources, and inspect the result:
 *
 *   const result = await renderWidgetForTest(myWidget, { entityId: "sensor.outdoor" });
 *   expect(result.hasError).toBe(false);
 *   expect(result.inkPixels).toBeGreaterThan(0);
 */
import sharp from "sharp";

import { WidgetRegistry } from "./registry.js";
import { renderScreenSvg } from "./render.js";
import type { WidgetDefinition, WidgetServices } from "./types.js";

export function createTestServices(overrides: Partial<WidgetServices> = {}): WidgetServices {
  return {
    timeZone: "UTC",
    now: new Date("2026-01-15T15:30:00.000Z"),
    homeAssistant: {
      configured: true,
      getState: async (entityId) => ({
        entityId,
        state: "21.5",
        unit: "°C",
        friendlyName: "Test sensor",
      }),
    },
    calendar: {
      configured: true,
      getEvents: async () => [
        {
          title: "Team meeting",
          start: "2026-01-15T17:00:00Z",
          end: "2026-01-15T18:00:00Z",
          allDay: false,
          location: null,
        },
        {
          title: "Holiday",
          start: "2026-01-16",
          end: "2026-01-17",
          allDay: true,
          location: null,
        },
      ],
    },
    todo: {
      configured: true,
      getTasks: async () => [
        {
          id: "task-1",
          title: "Pay rent",
          listId: "list-1",
          listName: "Tasks",
          dueDate: "2026-01-15",
          importance: "high",
          recurring: true,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "task-2",
          title: "Buy milk",
          listId: "list-1",
          listName: "Tasks",
          dueDate: null,
          importance: "normal",
          recurring: false,
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
    fetchJson: async () => {
      throw new Error("fetchJson is not stubbed in this test");
    },
    ...overrides,
  };
}

export interface WidgetTestResult {
  svg: string;
  width: number;
  height: number;
  /** True when the widget rendered as an error box instead of its own output. */
  hasError: boolean;
  /** Dark pixels inside the widget content area after 1-bit conversion. */
  inkPixels: number;
}

export async function renderWidgetForTest<Definition extends WidgetDefinition>(
  definition: Definition,
  config: Record<string, unknown> = definition.defaultConfig,
  services: WidgetServices = createTestServices(),
): Promise<WidgetTestResult> {
  const registry = new WidgetRegistry();
  registry.register(definition);
  const svg = await renderScreenSvg(
    { name: "Widget test", widgets: [{ ...config, type: definition.type }] },
    registry,
    services,
  );
  const { data, info } = await sharp(Buffer.from(svg))
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let inkPixels = 0;
  for (let y = 32; y < 440; y += 1) {
    for (let x = 32; x < 768; x += 1) {
      if (data[y * info.width + x]! < 128) {
        inkPixels += 1;
      }
    }
  }
  return {
    svg,
    width: info.width,
    height: info.height,
    hasError: svg.includes("WIDGET ERROR"),
    inkPixels,
  };
}
