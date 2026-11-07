import { charsThatFit, defineWidget, svgText, Type, wrapText } from "../sdk.js";

const FONT_SIZE = 24;
const LINE_HEIGHT = 32;
const MAX_LINES = 6;

const lines = (text: string, width: number) =>
  wrapText(text, charsThatFit(width, FONT_SIZE), MAX_LINES);

export default defineWidget({
  type: "text",
  name: "Text",
  description: "Wrapped message, up to six lines",
  configSchema: Type.Object({
    text: Type.String({ minLength: 1, maxLength: 500, title: "Text", "x-input": "textarea" }),
  }),
  defaultConfig: { text: "Your message" },
  height: (config, _data, width) => lines(config.text, width).length * LINE_HEIGHT,
  render: (config, _data, box) =>
    lines(config.text, box.width)
      .map((line, index) => svgText(0, 24 + index * LINE_HEIGHT, line, FONT_SIZE))
      .join(""),
});
