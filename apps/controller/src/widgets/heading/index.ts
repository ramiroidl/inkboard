import { defineWidget, fitToWidth, svgText, Type } from "../sdk.js";

/** Font size and row height for each size choice. */
const SIZES = {
  small: { font: 24, height: 32 },
  medium: { font: 32, height: 42 },
  large: { font: 40, height: 52 },
} as const;

export default defineWidget({
  type: "heading",
  name: "Heading",
  description: "Bold title",
  configSchema: Type.Object({
    text: Type.String({ minLength: 1, maxLength: 80, title: "Text" }),
    size: Type.Optional(
      Type.Union(
        [
          Type.Literal("large", { title: "Large" }),
          Type.Literal("medium", { title: "Medium" }),
          Type.Literal("small", { title: "Small" }),
        ],
        { title: "Size" },
      ),
    ),
  }),
  defaultConfig: { text: "Heading", size: "large" },
  height: (config) => SIZES[config.size ?? "large"].height,
  render: (config, _data, box) => {
    const { font, height } = SIZES[config.size ?? "large"];
    return svgText(
      0,
      Math.round(height * 0.77),
      fitToWidth(config.text, box.width, font, true),
      font,
      {
        bold: true,
      },
    );
  },
});
