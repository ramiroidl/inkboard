import type { ScreenWidget } from "@inkboard/contracts";

import type { WidgetRegistry } from "./registry.js";
import { charsThatFit, svgText, truncate } from "./sdk.js";
import type { WidgetDefinition, WidgetEnvironment, WidgetServices } from "./types.js";

const WIDTH = 800;
const HEIGHT = 480;
const MARGIN = 32;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;
const CONTENT_BOTTOM = 440;
const GAP = 16;
const CELL_GAP = 16;
const ERROR_HEIGHT = 52;
const LOAD_TIMEOUT_MS = 15_000;

/**
 * Plugin output may only draw. Scripts, styles, links, external references, and DTDs could
 * load resources or make rendering nondeterministic, so any match is replaced by an error.
 */
const UNSAFE_SVG =
  /<\s*(script|style|image|img|foreignObject|iframe|use|a)\b|<!|\b(xlink:)?href\s*=|\son[a-z]+\s*=|url\(\s*(?!#)/i;

type Resolved =
  | { kind: "ok"; definition: WidgetDefinition; config: Record<string, unknown>; data: unknown }
  | { kind: "error"; message: string };

interface Cell {
  item: Resolved;
  height: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out loading data")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWidget(
  widget: ScreenWidget,
  registry: WidgetRegistry,
  services: WidgetServices,
): Promise<Resolved> {
  const definition = registry.get(widget.type);
  const problem = registry.check(widget);
  if (definition === undefined || problem !== null) {
    return { kind: "error", message: problem ?? `Unknown widget type "${widget.type}"` };
  }
  const config: Record<string, unknown> = { ...widget };
  delete config.type;
  try {
    const data =
      definition.load === undefined
        ? undefined
        : await withTimeout(definition.load(config, services), LOAD_TIMEOUT_MS);
    return { kind: "ok", definition, config, data };
  } catch (error: unknown) {
    return { kind: "error", message: `${definition.name}: ${describeError(error)}` };
  }
}

/** Consecutive widgets of a type that allows it share a row. */
function groupRows(items: Resolved[]): Resolved[][] {
  const rows: Resolved[][] = [];
  for (const item of items) {
    const previous = rows.at(-1);
    const head = previous?.[0];
    if (
      item.kind === "ok" &&
      head?.kind === "ok" &&
      head.definition.type === item.definition.type &&
      previous!.length < (item.definition.maxPerRow ?? 1)
    ) {
      previous!.push(item);
    } else {
      rows.push([item]);
    }
  }
  return rows;
}

function measure(item: Resolved, width: number, environment: WidgetEnvironment): Cell {
  if (item.kind === "error") {
    return { item, height: ERROR_HEIGHT };
  }
  try {
    const height = item.definition.height(item.config, item.data, width, environment);
    if (!Number.isFinite(height) || height <= 0 || height > CONTENT_BOTTOM - MARGIN) {
      throw new Error(`Invalid height ${height}`);
    }
    return { item, height: Math.ceil(height) };
  } catch (error: unknown) {
    return {
      item: { kind: "error", message: `${item.definition.name}: ${describeError(error)}` },
      height: ERROR_HEIGHT,
    };
  }
}

function errorBox(message: string, width: number, height: number): string {
  return `
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="black" stroke-width="2" stroke-dasharray="8 6"/>
    ${svgText(12, Math.min(height - 12, 33), truncate(`WIDGET ERROR · ${message}`, charsThatFit(width - 24, 16, true)), 16, { bold: true })}
  `;
}

function renderCell(
  cell: Cell,
  x: number,
  y: number,
  width: number,
  height: number,
  environment: WidgetEnvironment,
): string {
  let content: string;
  if (cell.item.kind === "error") {
    content = errorBox(cell.item.message, width, height);
  } else {
    try {
      content = cell.item.definition.render(
        cell.item.config,
        cell.item.data,
        { width, height },
        environment,
      );
      if (UNSAFE_SVG.test(content)) {
        content = errorBox(`${cell.item.definition.name}: unsafe SVG output`, width, height);
      }
    } catch (error: unknown) {
      content = errorBox(`${cell.item.definition.name}: ${describeError(error)}`, width, height);
    }
  }
  // A nested viewport gives the widget local coordinates and clips anything outside its box.
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">${content}</svg>`;
}

/**
 * Lays widgets out top to bottom. Widgets that would overflow the content area are omitted
 * and counted in the footer. A failing widget renders as an error box without affecting
 * the rest of the screen.
 */
export async function renderScreenSvg(
  screen: { name: string; widgets: ScreenWidget[] },
  registry: WidgetRegistry,
  services: WidgetServices,
): Promise<string> {
  const environment: WidgetEnvironment = { timeZone: services.timeZone, now: services.now };
  const resolved = await Promise.all(
    screen.widgets.map((widget) => resolveWidget(widget, registry, services)),
  );

  // A lone full-screen widget draws on the whole canvas.
  const only = resolved.length === 1 ? resolved[0]! : null;
  if (only?.kind === "ok" && only.definition.fullScreen === true) {
    const fullEnvironment: WidgetEnvironment = { ...environment, availableHeight: HEIGHT };
    return `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${HEIGHT}" fill="white"/>
      ${renderCell({ item: only, height: HEIGHT }, 0, 0, WIDTH, HEIGHT, fullEnvironment)}
    </svg>`;
  }

  let y = MARGIN;
  let omitted = 0;
  const rendered: string[] = [];
  for (const row of groupRows(resolved)) {
    const cellWidth = (CONTENT_WIDTH - CELL_GAP * (row.length - 1)) / row.length;
    const rowEnvironment: WidgetEnvironment = {
      ...environment,
      availableHeight: CONTENT_BOTTOM - y,
    };
    const cells = row.map((item) => measure(item, cellWidth, rowEnvironment));
    const rowHeight = Math.max(...cells.map((cell) => cell.height));
    if (omitted > 0 || y + rowHeight > CONTENT_BOTTOM) {
      omitted += row.length;
      continue;
    }
    cells.forEach((cell, index) => {
      rendered.push(
        renderCell(
          cell,
          MARGIN + index * (cellWidth + CELL_GAP),
          y,
          cellWidth,
          rowHeight,
          rowEnvironment,
        ),
      );
    });
    y += rowHeight + GAP;
  }

  return `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${HEIGHT}" fill="white"/>
      <rect x="1" y="1" width="798" height="478" fill="none" stroke="black" stroke-width="2"/>
      ${rendered.join("")}
      <line x1="${MARGIN}" y1="452" x2="${WIDTH - MARGIN}" y2="452" stroke="black" stroke-width="2"/>
      ${svgText(MARGIN, 471, truncate(screen.name.toUpperCase(), 60), 14)}
      ${
        omitted > 0
          ? svgText(
              WIDTH - MARGIN,
              471,
              `+${omitted} WIDGET${omitted === 1 ? "" : "S"} DID NOT FIT`,
              14,
              { anchor: "end" },
            )
          : ""
      }
    </svg>
  `;
}
