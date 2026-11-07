import sharp from "sharp";
import { describe, expect, it } from "vitest";
import japanese, { lessonFor, type JapaneseConfig } from "./japanese/index.js";
import { GRAMMAR, VOCABULARY } from "./japanese/data.js";
import { WidgetRegistry } from "./registry.js";
import { renderScreenSvg } from "./render.js";
import { createTestServices, renderWidgetForTest } from "./testing.js";

const config = (changes: Partial<JapaneseConfig> = {}): JapaneseConfig => ({
  ...japanese.defaultConfig,
  startDate: "2026-11-07",
  ...changes,
});
const environment = (now = "2026-11-07T12:00:00Z", timeZone = "UTC") =>
  createTestServices({ now: new Date(now), timeZone });

describe("Japanese study lessons", () => {
  it("starts with N5 words and the ます lesson without requiring a connection", () => {
    const lesson = lessonFor(config(), environment());
    expect(lesson.words.map((word) => word.word)).toEqual(["食べる", "飲む", "見る"]);
    expect(lesson.grammar).toMatchObject({
      title: "ます: polite non-past",
      reading: "まいにち、ごはんをたべます。",
    });
  });

  it("is stable across refreshes and advances vocabulary daily and grammar weekly", () => {
    const first = lessonFor(config(), environment());
    expect(lessonFor(config(), environment("2026-11-07T23:59:59Z"))).toEqual(first);
    const next = lessonFor(config(), environment("2026-11-08T00:00:00Z"));
    expect(next.words.map((word) => word.word)).toEqual(["行く", "来る", "する"]);
    expect(next.grammar).toEqual(first.grammar);
    expect(lessonFor(config(), environment("2026-11-14T12:00:00Z")).grammar).not.toEqual(
      first.grammar,
    );
  });

  it("uses local dates across midnight and daylight-saving transitions", () => {
    const settings = config({ startDate: "2026-10-31" });
    expect(
      lessonFor(settings, environment("2026-11-01T03:59:00Z", "America/New_York")).vocabularyStep,
    ).toBe(0);
    expect(
      lessonFor(settings, environment("2026-11-01T04:00:00Z", "America/New_York")).vocabularyStep,
    ).toBe(1);
    expect(
      lessonFor(settings, environment("2026-11-01T06:00:00Z", "America/New_York")).vocabularyStep,
    ).toBe(1);
  });

  it("advances hourly without changing inside an hour, and supports daily grammar", () => {
    const settings = config({ vocabularyFrequency: "hourly", grammarFrequency: "daily" });
    expect(lessonFor(settings, environment("2026-11-07T12:00:00Z"))).toEqual(
      lessonFor(settings, environment("2026-11-07T12:59:59Z")),
    );
    expect(lessonFor(settings, environment("2026-11-07T13:00:00Z")).vocabularyStep).toBe(13);
    expect(lessonFor(settings, environment("2026-11-08T12:00:00Z")).grammarStep).toBe(1);
  });

  it("wraps vocabulary and honors the word count for short uploaded lists", () => {
    const words = [{ word: "猫", reading: "ねこ", translation: "cat" }];
    expect(lessonFor(config({ source: "uploaded", words }), environment()).words).toEqual(words);
    const cycle = VOCABULARY.n5.length / 3;
    const later = new Date(Date.parse("2026-11-07T12:00:00Z") + cycle * 86_400_000);
    expect(lessonFor(config(), environment(later.toISOString())).words).toEqual(
      lessonFor(config(), environment()).words,
    );
    expect(lessonFor(config({ source: "uploaded" }), environment()).words).toEqual([]);
  });

  it("keeps uploaded selections independent and supports travel and combined packs", () => {
    const own = [{ word: "猫", reading: "ねこ", translation: "cat" }];
    expect(lessonFor(config({ source: "uploaded", words: own }), environment()).words).toEqual(own);
    expect(lessonFor(config({ pack: "travel" }), environment()).words[0]!.word).toBe("駅");
    const all = config({ source: "combined", pack: "travel", words: own, wordsPerScreen: 1 });
    expect(lessonFor(all, environment("2026-12-01T12:00:00Z")).words[0]!.word).toBe("猫");
    expect(
      lessonFor(
        config({ source: "uploaded", words: [...own, { ...own[0]!, translation: "a feline" }] }),
        environment(),
      ).words,
    ).toHaveLength(2);
  });

  it("filters grammar by proficiency and topic, including irregular verbs", () => {
    for (const proficiency of ["starter", "n5"] as const) {
      for (const grammarFocus of ["auto", "polite", "past", "particles"] as const) {
        for (let day = 0; day < 20; day += 1) {
          const now = new Date(Date.parse("2026-11-07T12:00:00Z") + day * 86_400_000);
          const lesson = lessonFor(
            config({ proficiency, grammarFocus, grammarFrequency: "daily" }),
            environment(now.toISOString()),
          ).grammar;
          expect(lesson).toBeDefined();
          if (proficiency === "starter") expect(lesson.starter).toBe(true);
          if (grammarFocus !== "auto") expect(lesson.topic).toBe(grammarFocus);
        }
      }
    }
    expect(GRAMMAR.some((lesson) => lesson.explanation.includes("きます"))).toBe(true);
  });

  it("rejects impossible course dates and does not advance before a future start date", () => {
    expect(() => lessonFor(config({ startDate: "2026-02-30" }), environment())).toThrow(
      "real calendar date",
    );
    expect(lessonFor(config({ startDate: "2026-12-01" }), environment()).vocabularyStep).toBe(0);
  });
});

describe("Japanese study rendering", () => {
  it("keeps every bundled Japanese spelling and reading visible with three cards", async () => {
    for (const pack of ["n5", "travel"] as const) {
      for (let day = 0; day < VOCABULARY[pack].length / 3; day += 1) {
        const now = new Date(Date.parse("2026-11-07T12:00:00Z") + day * 86_400_000);
        const settings = config({ mode: "vocabulary", pack });
        const services = environment(now.toISOString());
        const lesson = lessonFor(settings, services);
        const result = await renderWidgetForTest(japanese, settings, services);
        for (const word of lesson.words) {
          expect(result.svg).toContain(`>${word.word}</text>`);
          expect(result.svg).toContain(`>${word.reading}</text>`);
        }
      }
    }
  });

  it.each(["mixed", "vocabulary", "grammar"] as const)(
    "renders %s on the full 800×480 canvas",
    async (mode) => {
      const result = await renderWidgetForTest(japanese, config({ mode }), environment());
      expect(result).toMatchObject({ width: 800, height: 480, hasError: false });
      expect(result.inkPixels).toBeGreaterThan(1000);
      expect(result.svg).toContain("Noto Sans CJK JP");
      if (mode !== "grammar") {
        expect(result.svg).toContain("食べる");
        expect(result.svg).toContain("たべる");
        expect(result.svg).toContain("to eat");
      }
      if (mode !== "vocabulary") expect(result.svg).toContain("polite non-past");
    },
  );

  it("shows romaji only when enabled and displays imported examples", async () => {
    const word = {
      word: "猫",
      reading: "ねこ",
      translation: "cat",
      romaji: "neko",
      example: "猫がいます。",
      example_reading: "ねこがいます。",
      example_translation: "There is a cat.",
    };
    const settings = config({
      mode: "vocabulary",
      source: "uploaded",
      words: [word],
      wordsPerScreen: 1,
    });
    expect((await renderWidgetForTest(japanese, settings, environment())).svg).not.toContain(
      ">neko<",
    );
    const result = await renderWidgetForTest(
      japanese,
      { ...settings, showRomaji: true },
      environment(),
    );
    expect(result.svg).toContain(">neko<");
    expect(result.svg).toContain("猫がいます。");
    expect(result.svg).toContain("There is a cat.");
  });

  it("escapes uploaded text rather than inserting SVG markup", async () => {
    const result = await renderWidgetForTest(
      japanese,
      config({
        source: "uploaded",
        words: [{ word: "<script>x</script>", reading: "かな", translation: "a & b" }],
      }),
      environment(),
    );
    expect(result.hasError).toBe(false);
    expect(result.svg).toContain("&lt;script&gt;");
    expect(result.svg).toContain("a &amp; b");
  });

  it("remains usable in a mixed screen and reports missing uploaded words", async () => {
    const registry = new WidgetRegistry();
    registry.register(japanese);
    const svg = await renderScreenSvg(
      {
        name: "Study",
        widgets: [{ type: "japanese", ...config({ source: "uploaded" }) }],
      },
      registry,
      environment(),
    );
    expect(svg).toContain("No uploaded words");
    // A second study widget disables the lone-widget full-screen path.
    const combined = await renderScreenSvg(
      {
        name: "Study",
        widgets: [
          { type: "japanese", ...config() },
          { type: "japanese", ...config() },
        ],
      },
      registry,
      environment(),
    );
    expect(combined).not.toContain("WIDGET ERROR");
    expect(combined).toContain("I eat rice every day.");
  });

  it("renders distinct kanji and kana glyphs, not identical missing-glyph boxes", async () => {
    const glyph = async (value: string) =>
      sharp(
        Buffer.from(
          `<svg width="80" height="80" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="80" fill="white"/><text x="5" y="60" font-family="Noto Sans CJK JP, sans-serif" font-size="48">${value}</text></svg>`,
        ),
      )
        .greyscale()
        .raw()
        .toBuffer();
    expect(await glyph("食")).not.toEqual(await glyph("語"));
    expect(await glyph("あ")).not.toEqual(await glyph("い"));
  });
});
