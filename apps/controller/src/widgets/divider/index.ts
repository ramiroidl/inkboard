import { defineWidget, Type } from "../sdk.js";

export default defineWidget({
  type: "divider",
  name: "Divider",
  description: "Heavy horizontal rule",
  configSchema: Type.Object({}),
  defaultConfig: {},
  height: () => 8,
  render: (_config, _data, box) =>
    `<line x1="0" y1="4" x2="${box.width}" y2="4" stroke="black" stroke-width="4"/>`,
});
