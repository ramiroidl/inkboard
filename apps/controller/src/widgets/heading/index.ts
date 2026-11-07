import { charsThatFit, defineWidget, svgText, truncate, Type } from "../sdk.js";

export default defineWidget({
  type: "heading",
  name: "Heading",
  description: "Large bold title",
  configSchema: Type.Object({
    text: Type.String({ minLength: 1, maxLength: 80, title: "Text" }),
  }),
  defaultConfig: { text: "Heading" },
  height: () => 52,
  render: (config, _data, box) =>
    svgText(0, 40, truncate(config.text, charsThatFit(box.width, 40, true)), 40, { bold: true }),
});
