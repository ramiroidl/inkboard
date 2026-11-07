import { describe, expect, it } from "vitest";
import japanese from "../../controller/src/widgets/japanese/index.js";
import { WidgetRegistry } from "../../controller/src/widgets/registry.js";
import { newWidget } from "./widget-defaults.js";

describe("new widget defaults", () => {
  it("starts a new course on the controller's local date without modifying defaults", () => {
    const registry = new WidgetRegistry();
    registry.register(japanese);
    const descriptor = registry.describe()[0]!;
    const now = new Date("2026-11-08T01:00:00Z");
    const first = newWidget(descriptor, "America/Chicago", now);
    const second = newWidget(descriptor, "Asia/Tokyo", now);
    expect(first.startDate).toBe("2026-11-07");
    expect(second.startDate).toBe("2026-11-08");
    expect(descriptor.defaultConfig.startDate).toBe("2026-01-01");
    expect(first.words).not.toBe(second.words);
  });
});
