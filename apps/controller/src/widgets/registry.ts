import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ScreenWidget, WidgetDescriptor, WidgetSettingSchema } from "@inkboard/contracts";
import { Type, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { WidgetDefinition } from "./types.js";

const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const WIDGETS_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export class InvalidWidgetError extends Error {}

/**
 * Imports every `widgets/<type>/index.(js|ts)` default export. Folders starting with `_` or
 * `.` are skipped so authors can keep drafts or shared helpers next to plugins.
 */
export async function discoverWidgets(directory = WIDGETS_DIRECTORY): Promise<WidgetDefinition[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const definitions: WidgetDefinition[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) {
      continue;
    }
    const files = await readdir(join(directory, entry.name));
    const file = ["index.js", "index.ts"].find((candidate) => files.includes(candidate));
    if (file === undefined) {
      continue;
    }
    const module = (await import(pathToFileURL(join(directory, entry.name, file)).href)) as {
      default?: WidgetDefinition;
    };
    if (module.default === undefined) {
      throw new Error(`Widget folder ${entry.name} has no default export`);
    }
    if (module.default.type !== entry.name) {
      throw new Error(
        `Widget folder ${entry.name} exports type "${module.default.type}"; they must match`,
      );
    }
    definitions.push(module.default);
  }
  return definitions;
}

export class WidgetRegistry {
  private readonly definitions = new Map<string, WidgetDefinition>();
  private readonly schemas = new Map<string, TObject>();

  public register(definition: WidgetDefinition): void {
    if (!TYPE_PATTERN.test(definition.type)) {
      throw new Error(`Widget type "${definition.type}" must match ${TYPE_PATTERN}`);
    }
    if (this.definitions.has(definition.type)) {
      throw new Error(`Widget type "${definition.type}" is registered twice`);
    }
    if (definition.name.trim() === "") {
      throw new Error(`Widget "${definition.type}" needs a name`);
    }
    if ("type" in definition.configSchema.properties) {
      throw new Error(`Widget "${definition.type}" settings must not define "type"`);
    }
    const maxPerRow = definition.maxPerRow ?? 1;
    if (!Number.isInteger(maxPerRow) || maxPerRow < 1 || maxPerRow > 4) {
      throw new Error(`Widget "${definition.type}" maxPerRow must be 1 through 4`);
    }
    if (typeof definition.height !== "function" || typeof definition.render !== "function") {
      throw new Error(`Widget "${definition.type}" must implement height and render`);
    }

    const schema = Type.Object(
      { type: Type.Literal(definition.type), ...definition.configSchema.properties },
      { additionalProperties: false },
    );
    const defaultError = Value.Errors(schema, {
      type: definition.type,
      ...(definition.defaultConfig as object),
    }).First();
    if (defaultError !== undefined) {
      throw new Error(
        `Widget "${definition.type}" defaultConfig is invalid: ${defaultError.path} ${defaultError.message}`,
      );
    }
    this.definitions.set(definition.type, definition);
    this.schemas.set(definition.type, schema);
  }

  public get(type: string): WidgetDefinition | undefined {
    return this.definitions.get(type);
  }

  public list(): WidgetDefinition[] {
    return [...this.definitions.values()];
  }

  /** Returns a readable problem with a stored widget, or null when it is valid. */
  public check(widget: unknown): string | null {
    if (typeof widget !== "object" || widget === null || !("type" in widget)) {
      return "Widget is missing its type";
    }
    const type = widget.type;
    if (typeof type !== "string") {
      return "Widget is missing its type";
    }
    const schema = this.schemas.get(type);
    if (schema === undefined) {
      return `Unknown widget type "${type}"`;
    }
    const error = Value.Errors(schema, widget).First();
    return error === undefined
      ? null
      : `${this.definitions.get(type)!.name}: ${error.path === "" ? "settings" : error.path} ${error.message}`;
  }

  public validateWidgets(widgets: unknown[]): ScreenWidget[] {
    widgets.forEach((widget, index) => {
      const problem = this.check(widget);
      if (problem !== null) {
        throw new InvalidWidgetError(`Widget ${index + 1}: ${problem}`);
      }
    });
    return widgets as ScreenWidget[];
  }

  public describe(): WidgetDescriptor[] {
    return this.list()
      .map((definition) => ({
        type: definition.type,
        name: definition.name,
        description: definition.description,
        maxPerRow: definition.maxPerRow ?? 1,
        defaultConfig: definition.defaultConfig,
        // TypeBox schemas are JSON Schema; round-tripping drops its internal symbols.
        configSchema: JSON.parse(JSON.stringify(definition.configSchema)) as WidgetSettingSchema,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

export async function createWidgetRegistry(
  extraWidgets: WidgetDefinition[] = [],
): Promise<WidgetRegistry> {
  const registry = new WidgetRegistry();
  for (const definition of [...(await discoverWidgets()), ...extraWidgets]) {
    registry.register(definition);
  }
  return registry;
}
