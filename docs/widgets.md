# Writing widgets

A widget is a self-contained plugin in its own folder. The controller discovers
it at startup, validates its settings, gives it data, and draws it on editable
screens. The admin editor builds the widget's settings form from its schema, so
a new widget needs no changes anywhere else.

For hosting, shared connections, and device delivery, see the
[README architecture diagram](../README.md#how-the-app-works).

## Quick start

Create `apps/controller/src/widgets/<type>/index.ts`. The folder name must
match the widget's `type`.

```ts
// apps/controller/src/widgets/outdoor/index.ts
import { charsThatFit, defineWidget, EntityIdSchema, svgText, truncate, Type } from "../sdk.js";

export default defineWidget({
  type: "outdoor",
  name: "Outdoor temperature",
  description: "Large outdoor temperature with a caption",
  configSchema: Type.Object({
    entityId: EntityIdSchema({ title: "Temperature sensor" }),
    caption: Type.String({ maxLength: 30, title: "Caption" }),
    showUnit: Type.Boolean({ title: "Show unit" }),
  }),
  defaultConfig: { entityId: "sensor.outdoor_temperature", caption: "Outside", showUnit: true },
  maxPerRow: 2,
  load: async (config, { homeAssistant }) => homeAssistant.getState(config.entityId),
  height: () => 120,
  render: (config, state, box) => {
    const value =
      state === null ? "—" : `${state.state}${config.showUnit ? (state.unit ?? "") : ""}`;
    return (
      svgText(0, 24, config.caption.toUpperCase(), 18, { bold: true }) +
      svgText(0, 100, truncate(value, charsThatFit(box.width, 72, true)), 72, { bold: true })
    );
  },
});
```

Rebuild and restart the controller. **Outdoor temperature** now appears under
**Add widget**, with a form for its three settings.

## The contract

A widget's default export is a `WidgetDefinition` (see `widgets/types.ts`).
Import only from `../sdk.js`, which re-exports the contract and helpers, so
widgets stay independent of controller internals.

| Field           | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `type`          | Unique ID stored in screens: lowercase letters, digits, `_`; matches folder |
| `name`          | Label in the editor                                                         |
| `description`   | Tooltip in the editor                                                       |
| `configSchema`  | TypeBox object schema for the settings; must not define `type`              |
| `defaultConfig` | Settings for a newly added widget; must satisfy the schema                  |
| `maxPerRow`     | 1–4. Consecutive widgets of this type share a row (default 1)               |
| `fullScreen`    | Alone on a screen, draw on the whole 800×480 canvas (default false)         |
| `load`          | Optional async data loading with the provided services                      |
| `height`        | Pixels needed at a given width                                              |
| `render`        | SVG fragment for the widget's box                                           |

For each render the controller:

1. validates the stored settings against `configSchema`;
2. calls `load(config, services)` (15 second limit);
3. calls `height(config, data, width, environment)`;
4. calls `render(config, data, box, environment)` and clips the result to the
   box.

If any step fails, that widget becomes a dashed error box and the rest of the
screen still renders.

### Settings and the generated form

`configSchema` is standard JSON Schema built with TypeBox. The editor reads
these keywords:

| Schema                                                       | Form control    |
| ------------------------------------------------------------ | --------------- |
| `Type.String()`                                              | Text input      |
| `Type.String({ "x-input": "textarea" })`                     | Multi-line text |
| `Type.Integer()` / `Type.Number()` with `minimum`, `maximum` | Number input    |
| `Type.Boolean()`                                             | Checkbox        |
| `Type.Union([Type.Literal("a", { title: "A" }), …])`         | Drop-down       |

`title` labels the field, `description` appears below it, and the first entry
of `examples` is the placeholder. `minLength`, `maxLength`, `pattern`,
`minimum`, and `maximum` are enforced when a screen is saved or previewed. Use
`EntityIdSchema()` for a Home Assistant entity ID with suggestions, and
`EntityIdListSchema({ domains: ["calendar"] })` for several entities, shown as
checkboxes, and `TodoListIdsSchema()` for Microsoft To Do lists.

Stored settings must match the schema exactly. If you change a schema, keep old
settings valid (add optional properties, or properties with defaults handled in
code) or existing screens will show an "invalid settings" error box.

### Services available in `load`

| Service                                | Description                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `homeAssistant.getState(entityId)`     | Entity state, unit, and friendly name, or `null`; cached, last good kept    |
| `homeAssistant.configured`             | False when no Home Assistant connection is configured                       |
| `homeAssistant.getLocation()`          | Home latitude, longitude, and temperature unit, or `null`                   |
| `calendar.getEvents(entityIds)`        | Upcoming events from this widget's selected calendars; empty means none     |
| `calendar.getEventsBetween(s, e, ids)` | Events in a date range from this widget's calendars; cached, last good kept |
| `todo.getTasks(listIds)`               | Open Microsoft To Do tasks from this widget's lists; empty means none       |
| `todo.configured`                      | False until Microsoft To Do is signed in                                    |
| `fetchJson(url, { ttlSeconds })`       | Cached JSON GET (http/https, 10 s timeout, 256 KB limit, last good kept)    |
| `timeZone`, `now`                      | Configured time zone and render time                                        |

Widgets never receive tokens or credentials. Sending the home location to an
outside service, as the month calendar's weather does, must be an opt-in
setting.

All widgets use the same registry, schema-driven editor, and rendering lifecycle.
Each screen stores the settings of each widget instance; there are no page-wide
calendar or To Do selections to inherit. Connections and credentials remain
shared and are managed under **Connections**. For optional selection properties
in older screens, pass `config.calendars ?? []` or `config.lists ?? []`.

The `height` and `render` environment also includes `availableHeight`, the
pixels left on the screen below the widget's top edge. List widgets use it to
show only the rows that fit.

### Drawing

- The canvas is 800×480, 1-bit black and white. Draw in black on the white
  background; anti-aliased edges are thresholded.
- Coordinates are local: `(0, 0)` is the widget's top-left corner and
  `box.width`/`box.height` are its size. Content outside the box is clipped.
- Use `svgText()` for text. It escapes content and uses DejaVu Sans; characters
  DejaVu lacks, such as most emoji, fall back to the monochrome Symbola font.
  `y` is the text baseline.
- Use `fitToWidth(text, width, fontSize, bold)` to cut single-line text with an
  ellipsis so it fits a pixel width; it accounts for wide capitals and emoji.
  `wrapText()` with `charsThatFit()` wraps longer text.
- Use `environment.now` and `environment.timeZone` (with `formatClock()`,
  `formatLongDate()`, `formatEventDay(event, timeZone, now)`, and
  `formatEventTime(event, timeZone, now)`, plus `formatDueDate()` and
  `describeTask()` for tasks) instead of `new Date()`, so previews
  and device images match.
- Output may not contain scripts, styles, links, `<image>`, `<use>`, external
  `url(...)` references, or DTDs. Such output is replaced by an error box.

Rendering is cached: if the SVG for a screen is unchanged, the device keeps its
current image and the panel does not redraw. Avoid output that changes on every
render, such as seconds or random values.

## Testing

`widgets/testing.ts` renders a widget exactly as the controller does, with
stubbed data sources:

```ts
import { describe, expect, it } from "vitest";

import { createTestServices, renderWidgetForTest } from "../testing.js";
import outdoor from "./index.js";

describe("outdoor widget", () => {
  it("renders the temperature", async () => {
    const result = await renderWidgetForTest(outdoor);
    expect(result.hasError).toBe(false);
    expect(result.inkPixels).toBeGreaterThan(0);
  });

  it("handles a missing sensor", async () => {
    const services = createTestServices({
      homeAssistant: { configured: true, getState: async () => null },
    });
    const result = await renderWidgetForTest(outdoor, outdoor.defaultConfig, services);
    expect(result.svg).toContain("—");
  });
});
```

Every widget folder is also covered by the conformance test in
`widgets/widgets.test.ts`, which renders each widget's default settings. Add
your widget's `type` to its `WIDGET_TYPES` list.

Run `npm test`, then preview the widget in the admin page with **New screen**.

## Third-party widgets

Widget plugins run inside the controller process, so only install widgets you
trust. Today a widget is added by placing its folder in
`apps/controller/src/widgets/` and rebuilding the image. Declarative widgets
(templates that run no code) and sandboxed code plugins are possible future
extensions.
