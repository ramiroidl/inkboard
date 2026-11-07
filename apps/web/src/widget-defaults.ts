import type { ScreenWidget, WidgetDescriptor } from "@inkboard/contracts";

export function newWidget(
  descriptor: WidgetDescriptor,
  timeZone: string,
  now = new Date(),
): ScreenWidget {
  const widget: ScreenWidget = {
    type: descriptor.type,
    ...structuredClone(descriptor.defaultConfig),
  };
  for (const [name, schema] of Object.entries(descriptor.configSchema.properties ?? {})) {
    if (schema["x-default"] === "today") {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((item) => item.type === type)!.value;
      widget[name] = `${part("year")}-${part("month")}-${part("day")}`;
    }
  }
  return widget;
}
