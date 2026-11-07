import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonFetchCache } from "../integrations/http-json.js";
import { createWidgetRegistry, discoverWidgets, WidgetRegistry } from "./registry.js";
import { renderScreenSvg } from "./render.js";
import { defineWidget, svgText, Type } from "./sdk.js";
import { createTestServices, renderWidgetForTest } from "./testing.js";
import type { WidgetDefinition } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const BUILT_IN = [
  "calendar",
  "calendar_month",
  "datetime",
  "divider",
  "entity",
  "heading",
  "text",
  "todo",
];

describe("widget discovery", () => {
  it("discovers every built-in widget folder", async () => {
    const definitions = await discoverWidgets();
    expect(definitions.map((definition) => definition.type)).toEqual(BUILT_IN);
  });

  it("skips drafts and folders without an entry point and checks folder names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inkboard-widgets-"));
    directories.push(directory);
    const plugin = (type: string) => `export default {
      type: "${type}", name: "Hello", description: "Test",
      configSchema: { type: "object", properties: {} }, defaultConfig: {},
      height() { return 40; }, render() { return ""; },
    };`;
    for (const folder of ["hello", "_draft", "empty"]) {
      await mkdir(join(directory, folder));
    }
    await writeFile(join(directory, "hello", "index.js"), plugin("hello"));
    await writeFile(join(directory, "_draft", "index.js"), plugin("draft"));
    await expect(discoverWidgets(directory)).resolves.toMatchObject([{ type: "hello" }]);

    await mkdir(join(directory, "wrong"));
    await writeFile(join(directory, "wrong", "index.js"), plugin("other"));
    await expect(discoverWidgets(directory)).rejects.toThrow("must match");
  });
});

describe("widget conformance", () => {
  it.each(BUILT_IN)("%s renders its default settings", async (type) => {
    const registry = await createWidgetRegistry();
    const definition = registry.get(type)!;
    const result = await renderWidgetForTest(definition);
    expect(result).toMatchObject({ width: 800, height: 480, hasError: false });
    expect(result.inkPixels).toBeGreaterThan(0);
  });

  it("describes widgets with JSON Schema for the editor", async () => {
    const registry = await createWidgetRegistry();
    const entity = registry.describe().find((widget) => widget.type === "entity")!;
    expect(entity).toMatchObject({
      name: "Home Assistant value",
      maxPerRow: 3,
      defaultConfig: { entityId: "sun.sun", label: "" },
      configSchema: {
        type: "object",
        properties: {
          entityId: { type: "string", title: "Entity ID", pattern: "^[a-z_]+\\.[a-z0-9_]+$" },
          label: { type: "string", maxLength: 40 },
        },
      },
    });
    const datetime = registry.describe().find((widget) => widget.type === "datetime")!;
    expect(datetime.defaultConfig).toEqual({ format: "date" });
    expect(datetime.configSchema.properties!.format!.anyOf).toEqual([
      expect.objectContaining({ const: "date", title: "Date only" }),
      expect.objectContaining({ const: "datetime", title: "Time and date" }),
      expect.objectContaining({ const: "time" }),
    ]);
  });
});

describe("widget registry", () => {
  const valid = defineWidget({
    type: "sample",
    name: "Sample",
    description: "Test widget",
    configSchema: Type.Object({ label: Type.String({ minLength: 1 }) }),
    defaultConfig: { label: "Hi" },
    height: () => 40,
    render: (config) => svgText(0, 30, config.label, 24),
  });

  it("rejects malformed definitions", () => {
    const attempts: Partial<WidgetDefinition>[] = [
      { type: "Bad-Type" },
      { name: " " },
      { defaultConfig: { label: "" } },
      { configSchema: Type.Object({ type: Type.String() }) },
      { maxPerRow: 9 },
    ];
    for (const changes of attempts) {
      expect(() => new WidgetRegistry().register({ ...valid, ...changes })).toThrow();
    }
    const registry = new WidgetRegistry();
    registry.register(valid);
    expect(() => registry.register(valid)).toThrow("registered twice");
  });

  it("validates stored widgets against the plugin schema", () => {
    const registry = new WidgetRegistry();
    registry.register(valid);
    expect(registry.check({ type: "sample", label: "ok" })).toBeNull();
    expect(registry.check({ type: "sample", label: "" })).toMatch(/^Sample: \/label/);
    expect(registry.check({ type: "sample", label: "ok", extra: 1 })).toMatch(/^Sample:/);
    expect(registry.check({ type: "missing" })).toBe('Unknown widget type "missing"');
    expect(() => registry.validateWidgets([{ type: "sample", label: "ok" }, {}])).toThrow(
      "Widget 2: Widget is missing its type",
    );
  });
});

describe("widget rendering isolation", () => {
  const plugin = (type: string, changes: Partial<WidgetDefinition>): WidgetDefinition => ({
    type,
    name: type,
    description: "Test",
    configSchema: Type.Object({}),
    defaultConfig: {},
    height: () => 40,
    render: () => svgText(0, 30, `${type} ok`, 20),
    ...changes,
  });

  it("replaces only the failing widget with an error box", async () => {
    const registry = new WidgetRegistry();
    for (const definition of [
      plugin("fine", {}),
      plugin("load_fails", {
        load: async () => {
          throw new Error("upstream down");
        },
      }),
      plugin("render_fails", {
        render: () => {
          throw new Error("bad data");
        },
      }),
      plugin("unsafe", { render: () => '<image href="http://evil.test/x.png"/>' }),
      plugin("too_tall", { height: () => 10_000 }),
    ]) {
      registry.register(definition);
    }
    const svg = await renderScreenSvg(
      {
        name: "Isolation",
        widgets: [
          { type: "fine" },
          { type: "load_fails" },
          { type: "render_fails" },
          { type: "unsafe" },
          { type: "too_tall" },
          { type: "uninstalled" },
        ],
      },
      registry,
      createTestServices(),
    );
    expect(svg).toContain("fine ok");
    for (const message of [
      "load_fails: upstream down",
      "render_fails: bad data",
      "unsafe: unsafe SVG output",
      "too_tall: Invalid height",
      "Unknown widget type",
    ]) {
      expect(svg).toContain(message);
    }
    expect(svg).not.toContain("evil.test");
  });

  it("clips widgets to their box and shares rows", async () => {
    const registry = new WidgetRegistry();
    registry.register(plugin("tile", { maxPerRow: 2 }));
    const svg = await renderScreenSvg(
      { name: "Rows", widgets: [{ type: "tile" }, { type: "tile" }, { type: "tile" }] },
      registry,
      createTestServices(),
    );
    const viewports = [...svg.matchAll(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/g)];
    expect(viewports.map((match) => [match[1], match[2], match[3]])).toEqual([
      ["32", "32", "360"],
      ["408", "32", "360"],
      ["32", "88", "736"],
    ]);
    expect(svg).toContain('overflow="hidden"');
  });
});

describe("fetchJson service", () => {
  it("caches, de-duplicates, and keeps the last good response", async () => {
    let now = new Date("2026-01-15T00:00:00Z");
    let fail = false;
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      if (fail) {
        throw new Error("offline");
      }
      return Response.json({ quote: "Stay curious" });
    });
    const cache = new JsonFetchCache(fetchImplementation, () => now);
    const url = "https://quotes.example.test/today.json";

    await expect(Promise.all([cache.getJson(url, 60), cache.getJson(url, 60)])).resolves.toEqual([
      { quote: "Stay curious" },
      { quote: "Stay curious" },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 61_000);
    fail = true;
    await expect(cache.getJson(url, 60)).resolves.toEqual({ quote: "Stay curious" });
    await expect(cache.getJson("https://other.example.test/x.json")).rejects.toThrow("offline");

    await expect(cache.getJson("file:///etc/passwd")).rejects.toThrow("only http and https");
    await expect(cache.getJson("https://user:pw@example.test/")).rejects.toThrow("credentials");
    await expect(cache.getJson("not a url")).rejects.toThrow("absolute URL");
  });

  it("is available to plugins registered with the app", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "inkboard-plugin-app-"));
    directories.push(dataDirectory);
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Response.json({ quote: "Stay curious" }),
    );
    const quote = defineWidget({
      type: "quote",
      name: "Quote",
      description: "Quote of the day",
      configSchema: Type.Object({ url: Type.String() }),
      defaultConfig: { url: "https://quotes.example.test/today.json" },
      load: async (config, services) =>
        (await services.fetchJson(config.url, { ttlSeconds: 3600 })) as { quote: string },
      height: () => 40,
      render: (_config, data) => svgText(0, 30, data.quote, 24),
    });
    const app = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        INKBOARD_DATA_DIR: dataDirectory,
        INKBOARD_LOG_LEVEL: "silent",
      }),
      { fetchImplementation, extraWidgets: [quote] },
    );

    const widgets = await app.inject({ method: "GET", url: "/api/v1/admin/widgets" });
    expect(widgets.json<{ widgets: { type: string }[] }>().widgets.map((w) => w.type)).toContain(
      "quote",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/admin/screens/preview.bmp",
        payload: { name: "Quote", widgets: [{ type: "quote", url: quote.defaultConfig.url }] },
      });
      expect(preview.statusCode).toBe(200);
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens",
      payload: { name: "Quote", widgets: [{ type: "quote" }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toMatch(/^Widget 1: Quote:/);

    await app.close();
  });
});

describe("list widgets", () => {
  it("show as many rows as fit instead of being left out", async () => {
    const registry = await createWidgetRegistry();
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index}`,
      title: `Task ${index}`,
      listId: "groceries",
      listName: "Groceries",
      dueDate: null,
      importance: "normal" as const,
      recurring: false,
      createdAt: null,
    }));
    const getTasks = vi.fn(async () => tasks);
    const svg = await renderScreenSvg(
      {
        name: "Groceries",
        widgets: [
          { type: "heading", text: "Groceries" },
          { type: "todo", maxItems: 10, lists: ["groceries"], hideDueDates: true },
        ],
      },
      registry,
      createTestServices({ todo: { configured: true, getTasks } }),
    );
    expect(getTasks).toHaveBeenCalledWith(["groceries"]);
    expect(svg).not.toContain("DID NOT FIT");
    expect(svg).toContain("Task 0");
    expect(svg).not.toContain("Task 9");
    expect(svg).toMatch(/\+\d+ MORE/);
  });
});
