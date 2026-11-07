import {
  charsThatFit,
  defineWidget,
  EntityIdSchema,
  svgText,
  truncate,
  Type,
  type EntityState,
} from "../sdk.js";

export function formatEntityValue(state: EntityState | null): string {
  if (state === null) {
    return "—";
  }
  const numeric = Number(state.state);
  const value =
    state.state.trim() !== "" && Number.isFinite(numeric)
      ? String(Math.round(numeric * 10) / 10)
      : state.state;
  return state.unit === null ? value : `${value} ${state.unit}`;
}

export default defineWidget({
  type: "entity",
  name: "Home Assistant value",
  description: "Any entity state and unit; up to three share a row",
  configSchema: Type.Object({
    entityId: EntityIdSchema(),
    label: Type.String({
      maxLength: 40,
      title: "Label",
      description: "Optional; defaults to the entity's name",
    }),
  }),
  defaultConfig: { entityId: "sun.sun", label: "" },
  maxPerRow: 3,
  load: async (config, { homeAssistant }) => ({
    configured: homeAssistant.configured,
    state: await homeAssistant.getState(config.entityId),
  }),
  height: () => 104,
  render: (config, data, box) => {
    const label =
      config.label.trim() !== "" ? config.label : (data.state?.friendlyName ?? config.entityId);
    const value = data.configured ? formatEntityValue(data.state) : "Not configured";
    const valueSize = data.configured ? 40 : 24;
    return `
      <rect x="1" y="1" width="${box.width - 2}" height="${box.height - 2}" fill="none" stroke="black" stroke-width="2"/>
      ${svgText(16, 32, truncate(label.toUpperCase(), charsThatFit(box.width - 32, 17, true)), 17, { bold: true })}
      ${svgText(16, 82, truncate(value, charsThatFit(box.width - 32, valueSize, true)), valueSize, { bold: true })}
    `;
  },
});
