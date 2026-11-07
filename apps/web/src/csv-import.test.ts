import { describe, expect, it } from "vitest";
import japanese from "../../controller/src/widgets/japanese/index.js";
import { WidgetRegistry } from "../../controller/src/widgets/registry.js";
import { decodeCsv, MAX_CSV_BYTES, parseCsv } from "./csv-import.js";

const registry = new WidgetRegistry();
registry.register(japanese);
const schema = registry.describe()[0]!.configSchema.properties!.words!;

describe("widget CSV import", () => {
  it("imports UTF-8 Japanese, trims cells, and preserves optional examples", () => {
    expect(
      parseCsv(
        "\uFEFFword,reading,translation,level,example,example_reading,example_translation\r\n 食べる ,たべる,to eat,N5,ご飯を食べます。,ごはんをたべます。,I eat rice.\r\n",
        schema,
      ),
    ).toEqual([
      {
        word: "食べる",
        reading: "たべる",
        translation: "to eat",
        level: "N5",
        example: "ご飯を食べます。",
        example_reading: "ごはんをたべます。",
        example_translation: "I eat rice.",
      },
    ]);
  });

  it("handles commas, escaped quotes, multiline cells, and blank lines", () => {
    expect(
      parseCsv(
        'word,reading,translation\n\n見る,みる,"to see, to watch"\n言う,いう,"to say ""hello""\non two lines"\n',
        schema,
      ),
    ).toEqual([
      { word: "見る", reading: "みる", translation: "to see, to watch" },
      { word: "言う", reading: "いう", translation: 'to say "hello"\non two lines' },
    ]);
  });

  it("omits empty optional fields", () => {
    expect(parseCsv("word,reading,translation,level,romaji\n猫,ねこ,cat,,\n", schema)).toEqual([
      { word: "猫", reading: "ねこ", translation: "cat" },
    ]);
  });

  it.each([
    ["", "header"],
    ["word,reading,translation\n", "at least one"],
    ["word,translation\n猫,cat", "reading"],
    ["word,reading,translation,extra\n猫,ねこ,cat,x", "Unknown"],
    ["word,reading,translation,__proto__\n猫,ねこ,cat,x", "Unknown"],
    ["word,reading,translation,constructor\n猫,ねこ,cat,x", "Unknown"],
    ["word,reading,translation,word\n猫,ねこ,cat,猫", "duplicated"],
    ["word,reading,translation\n猫,,cat", "row 2: reading"],
    ["word,reading,translation\n猫,neko,cat", "row 2: reading"],
    ["word,reading,translation\n猫,ねこ", "row 2: expected"],
    ["word,reading,translation,level\n猫,ねこ,cat,N0", "row 2: level"],
    ['word,reading,translation\n猫,ねこ,"cat', "CSV"],
    ["word,reading,translation\n猫,ねこ,cat\n猫,ねこ,cat", "duplicate record"],
    [`word,reading,translation\n${"あ".repeat(41)},あ,word`, "exceeds 40"],
  ])("rejects invalid input without returning a partial list: %s", (csv, message) => {
    expect(() => parseCsv(csv, schema)).toThrow(message);
  });

  it("enforces row and byte limits", () => {
    expect(() =>
      parseCsv(
        "word,reading,translation\n" +
          Array.from({ length: 201 }, (_, index) => `語${index},ご,word ${index}`).join("\n"),
        schema,
      ),
    ).toThrow("at most 200");
    expect(() => parseCsv("a".repeat(MAX_CSV_BYTES + 1), schema)).toThrow("128 KiB");
    expect(() => decodeCsv(new ArrayBuffer(MAX_CSV_BYTES + 1))).toThrow("128 KiB");
  });

  it("rejects malformed UTF-8 instead of replacing Japanese characters", () => {
    expect(() => decodeCsv(Uint8Array.from([0xff, 0xfe, 0x41]).buffer)).toThrow("UTF-8");
    const bytes = new TextEncoder().encode("猫");
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    expect(decodeCsv(buffer)).toBe("猫");
  });
});
