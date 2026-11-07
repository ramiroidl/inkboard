import { defineWidget, formatClock, formatLongDate, svgText, Type } from "../sdk.js";

export default defineWidget({
  type: "datetime",
  name: "Date & time",
  description:
    "Date, clock, or both in the configured time zone. The display refreshes every few minutes, so a clock can be behind; prefer Date only.",
  configSchema: Type.Object({
    format: Type.Union(
      [
        Type.Literal("date", { title: "Date only" }),
        Type.Literal("datetime", { title: "Time and date" }),
        Type.Literal("time", { title: "Time only" }),
      ],
      { title: "Format" },
    ),
  }),
  defaultConfig: { format: "date" as const },
  height: (config) => ({ datetime: 128, time: 88, date: 52 })[config.format],
  render: (config, _data, _box, { now, timeZone }) => {
    switch (config.format) {
      case "datetime":
        return (
          svgText(0, 72, formatClock(now, timeZone), 80, { bold: true }) +
          svgText(0, 116, formatLongDate(now, timeZone), 30)
        );
      case "time":
        return svgText(0, 74, formatClock(now, timeZone), 80, { bold: true });
      case "date":
        return svgText(0, 40, formatLongDate(now, timeZone), 40, { bold: true });
    }
  },
});
