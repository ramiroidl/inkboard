import {
  defineWidget,
  EntityIdListSchema,
  fitToWidth,
  formatEventDay,
  formatEventTime,
  svgText,
  Type,
  type CalendarEvent,
} from "../sdk.js";

const ROW_HEIGHT = 44;

/** The earliest events that fit in the available height. */
function fitEvents(events: CalendarEvent[], availableHeight: number | undefined): CalendarEvent[] {
  const rows = Math.floor((availableHeight ?? Number.POSITIVE_INFINITY) / ROW_HEIGHT);
  return events.slice(0, Math.max(1, rows));
}

export default defineWidget({
  type: "calendar",
  name: "Calendar agenda",
  description: "Next events from Home Assistant calendars",
  configSchema: Type.Object({
    maxEvents: Type.Integer({ minimum: 1, maximum: 8, title: "Events" }),
    calendars: Type.Optional(
      EntityIdListSchema({
        title: "Calendars",
        description: "Leave all unticked to use the calendars chosen in the Home Assistant card.",
        domains: ["calendar"],
      }),
    ),
  }),
  defaultConfig: { maxEvents: 4, calendars: [] },
  load: async (config, { calendar }) =>
    calendar.configured
      ? (await calendar.getEvents(config.calendars)).slice(0, config.maxEvents)
      : null,
  height: (_config, events, _width, { availableHeight }) =>
    events === null || events.length === 0
      ? ROW_HEIGHT
      : fitEvents(events, availableHeight).length * ROW_HEIGHT,
  render: (_config, events, box, { timeZone, now, availableHeight }) => {
    if (events === null || events.length === 0) {
      const message = events === null ? "Home Assistant not configured" : "No upcoming events";
      return `<line x1="0" y1="0" x2="${box.width}" y2="0" stroke="black" stroke-width="1"/>${svgText(12, 30, message, 20)}`;
    }
    return fitEvents(events, availableHeight)
      .map((event, index) => {
        const y = index * ROW_HEIGHT;
        return `
          <line x1="0" y1="${y}" x2="${box.width}" y2="${y}" stroke="black" stroke-width="1"/>
          ${svgText(12, y + 20, formatEventDay(event, timeZone, now).toUpperCase(), 15, { bold: true })}
          ${svgText(12, y + 38, formatEventTime(event, timeZone, now), 13)}
          <line x1="160" y1="${y + 8}" x2="160" y2="${y + 38}" stroke="black" stroke-width="3"/>
          ${svgText(178, y + 30, fitToWidth(event.title, box.width - 178, 22, true), 22, { bold: true })}
        `;
      })
      .join("");
  },
});
