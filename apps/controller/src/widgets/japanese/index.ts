import {
  defineWidget,
  escapeXml,
  localDateKey,
  Type,
  wrapText,
  type Static,
  type WidgetEnvironment,
} from "../sdk.js";
import { GRAMMAR, VOCABULARY, type GrammarLesson, type StudyWord } from "./data.js";

const DAY_MS = 86_400_000;
const FONT = "Noto Sans CJK JP, sans-serif";

const WordSchema = Type.Object(
  {
    word: Type.String({ minLength: 1, maxLength: 40, title: "Word" }),
    reading: Type.String({
      minLength: 1,
      maxLength: 80,
      title: "Kana reading",
      pattern: "^(?=.*[\\u3040-\\u30ff])[\\u3040-\\u30ff\\u3000\\s・ー]+$",
    }),
    translation: Type.String({ minLength: 1, maxLength: 160, title: "Translation" }),
    level: Type.Optional(Type.String({ pattern: "^N[1-5]$", title: "JLPT level" })),
    romaji: Type.Optional(Type.String({ maxLength: 80, title: "Romaji" })),
    example: Type.Optional(Type.String({ maxLength: 120, title: "Example sentence" })),
    example_reading: Type.Optional(Type.String({ maxLength: 160, title: "Example reading" })),
    example_translation: Type.Optional(
      Type.String({ maxLength: 200, title: "Example translation" }),
    ),
    tags: Type.Optional(Type.String({ maxLength: 80, title: "Topic tags" })),
  },
  { additionalProperties: false },
);

const ConfigSchema = Type.Object({
  mode: Type.Union(
    [
      Type.Literal("mixed", { title: "Vocabulary and grammar" }),
      Type.Literal("vocabulary", { title: "Vocabulary only" }),
      Type.Literal("grammar", { title: "Grammar only" }),
    ],
    { title: "Study mode" },
  ),
  source: Type.Union(
    [
      Type.Literal("bundled", { title: "Bundled vocabulary" }),
      Type.Literal("uploaded", { title: "Uploaded CSV" }),
      Type.Literal("combined", { title: "Bundled and uploaded words" }),
    ],
    { title: "Vocabulary source" },
  ),
  pack: Type.Union(
    [
      Type.Literal("n5", { title: "N5 starter vocabulary" }),
      Type.Literal("travel", { title: "Travel essentials" }),
      Type.Literal("both", { title: "N5 and travel" }),
    ],
    {
      title: "Vocabulary pack",
      description: "Curated starter packs, not official or exhaustive JLPT lists.",
    },
  ),
  proficiency: Type.Union(
    [
      Type.Literal("starter", { title: "Starting out" }),
      Type.Literal("n5", { title: "N5 / beginner review" }),
    ],
    { title: "Grammar proficiency" },
  ),
  grammarFocus: Type.Union(
    [
      Type.Literal("auto", { title: "Beginner course" }),
      Type.Literal("polite", { title: "です / ます and polite negatives" }),
      Type.Literal("past", { title: "Polite past forms" }),
      Type.Literal("particles", { title: "Basic particles" }),
    ],
    { title: "Grammar focus" },
  ),
  wordsPerScreen: Type.Integer({ minimum: 1, maximum: 3, title: "Words per screen" }),
  vocabularyFrequency: Type.Union(
    [Type.Literal("daily", { title: "Daily" }), Type.Literal("hourly", { title: "Hourly" })],
    { title: "Change vocabulary" },
  ),
  grammarFrequency: Type.Union(
    [Type.Literal("weekly", { title: "Weekly" }), Type.Literal("daily", { title: "Daily" })],
    { title: "Change grammar" },
  ),
  startDate: Type.String({
    pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$",
    title: "Course start date",
    "x-input": "date",
    "x-default": "today",
    description:
      "Lessons advance from this date in the controller's time zone. Refreshing does not skip ahead.",
  }),
  showRomaji: Type.Boolean({ title: "Show romaji when provided" }),
  words: Type.Array(WordSchema, {
    maxItems: 200,
    title: "Uploaded words",
    "x-input": "csv",
    description:
      "Import UTF-8 CSV, then choose Uploaded CSV or Bundled and uploaded words as the vocabulary source. Up to 200 words.",
  }),
});

export type JapaneseConfig = Static<typeof ConfigSchema>;

export interface StudyData {
  words: StudyWord[];
  grammar: GrammarLesson;
  vocabularyStep: number;
  grammarStep: number;
}

function dayNumber(key: string): number {
  const timestamp = Date.parse(`${key}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== key) {
    throw new Error("Course start date must be a real calendar date");
  }
  return timestamp / DAY_MS;
}

export function lessonFor(config: JapaneseConfig, environment: WidgetEnvironment): StudyData {
  const elapsed = Math.max(
    0,
    dayNumber(localDateKey(environment.now, environment.timeZone)) - dayNumber(config.startDate),
  );
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: environment.timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(environment.now),
  );
  const vocabularyStep = config.vocabularyFrequency === "hourly" ? elapsed * 24 + hour : elapsed;
  const grammarStep = config.grammarFrequency === "weekly" ? Math.floor(elapsed / 7) : elapsed;
  const bundled =
    config.pack === "both" ? [...VOCABULARY.n5, ...VOCABULARY.travel] : VOCABULARY[config.pack];
  const candidates =
    config.source === "uploaded"
      ? config.words
      : config.source === "combined"
        ? [...bundled, ...config.words]
        : bundled;
  const seen = new Set<string>();
  const deck = candidates.filter((word) => {
    const key = `${word.word}\u0000${word.reading}\u0000${word.translation}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const lessons = GRAMMAR.filter(
    (lesson) =>
      (config.proficiency !== "starter" || lesson.starter) &&
      (config.grammarFocus === "auto" || lesson.topic === config.grammarFocus),
  );
  const count = Math.min(config.wordsPerScreen, deck.length);
  return {
    words: Array.from(
      { length: count },
      (_, index) => deck[(vocabularyStep * config.wordsPerScreen + index) % deck.length]!,
    ),
    grammar: lessons[grammarStep % lessons.length]!,
    vocabularyStep,
    grammarStep,
  };
}

function textWidth(value: string, size: number): number {
  return [...value].reduce(
    (width, character) =>
      width +
      size *
        (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[。、→]/u.test(character)
          ? 1
          : character === " "
            ? 0.3
            : 0.65),
    0,
  );
}

function fit(value: string, width: number, size: number): string {
  if (textWidth(value, size) <= width) {
    return value;
  }
  let kept = "";
  for (const character of value) {
    if (textWidth(`${kept}${character}…`, size) > width) {
      break;
    }
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  width: number,
  bold = false,
): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${bold ? ' font-weight="700"' : ""}>${escapeXml(fit(value, width, size))}</text>`;
}

function lines(
  x: number,
  y: number,
  value: string,
  size: number,
  width: number,
  maxLines: number,
): string {
  return wrapText(value, Math.max(1, Math.floor(width / (size * 0.65))), maxLines)
    .map((line, index) => text(x, y + index * (size + 6), line, size, width))
    .join("");
}

function grammarSvg(lesson: GrammarLesson, width: number, height: number): string {
  if (height < 190) {
    return [
      text(0, 19, lesson.title, 17, width, true),
      lines(0, 40, lesson.explanation, 12, width, 2),
      text(0, 80, lesson.pattern, 17, width, true),
      text(0, 105, lesson.example, 17, width),
      text(0, 127, lesson.reading, 14, width),
      text(0, 147, lesson.translation, 13, width),
    ].join("");
  }
  const size = height >= 220 ? 23 : 19;
  return [
    text(0, 25, lesson.title, 21, width, true),
    lines(0, 53, lesson.explanation, 15, width, 2),
    text(0, 102, lesson.pattern, size, width, true),
    text(0, 136, lesson.example, size, width),
    text(0, 165, lesson.reading, 18, width),
    text(0, 192, lesson.translation, 16, width),
  ].join("");
}

export default defineWidget({
  type: "japanese",
  name: "Japanese Study",
  description:
    "Daily vocabulary and beginner grammar, with kana readings, translations, and your own CSV words.",
  fullScreen: true,
  configSchema: ConfigSchema,
  defaultConfig: {
    mode: "mixed",
    source: "bundled",
    pack: "n5",
    proficiency: "starter",
    grammarFocus: "auto",
    wordsPerScreen: 3,
    vocabularyFrequency: "daily",
    grammarFrequency: "weekly",
    startDate: "2026-01-01",
    showRomaji: false,
    words: [],
  },
  load: async (config, environment) => lessonFor(config, environment),
  height: (_config, _data, _width, { availableHeight }) => Math.max(260, availableHeight ?? 388),
  render: (config, data, box) => {
    const padding = box.width >= 780 ? 24 : 12;
    const width = box.width - padding * 2;
    const height = box.height - padding * 2;
    const header = text(0, 22, "JAPANESE STUDY", 20, width, true);
    const parts = [
      header,
      `<line x1="0" y1="36" x2="${width}" y2="36" stroke="black" stroke-width="2"/>`,
    ];
    if (config.mode === "grammar") {
      parts.push(
        `<g transform="translate(0 58)">${grammarSvg(data.grammar, width, height - 58)}</g>`,
      );
    } else {
      const compact = height < 410;
      const vocabHeight = config.mode === "mixed" ? (compact ? 140 : 155) : height - 70;
      const gap = 14;
      const count = Math.max(1, data.words.length);
      const cellWidth = (width - gap * (count - 1)) / count;
      if (data.words.length === 0) {
        parts.push(
          text(0, 86, "No uploaded words. Import a CSV in this widget's settings.", 18, width),
        );
      }
      for (const [index, word] of data.words.entries()) {
        const size = Math.min(
          compact ? 32 : 40,
          Math.max(18, Math.floor(cellWidth / Math.max(1, textWidth(word.word, 1)))),
        );
        const card = [
          text(0, compact ? 35 : 42, word.word, size, cellWidth, true),
          text(
            0,
            compact ? 64 : 75,
            word.reading,
            Math.min(
              compact ? 18 : 22,
              Math.max(14, Math.floor(cellWidth / Math.max(1, textWidth(word.reading, 1)))),
            ),
            cellWidth,
          ),
          lines(0, compact ? 90 : 104, word.translation, compact ? 15 : 17, cellWidth, 2),
        ];
        if (config.showRomaji && word.romaji) {
          card.push(text(0, compact ? 137 : 151, word.romaji, 14, cellWidth));
        }
        if (config.mode === "vocabulary" && word.example) {
          card.push(text(0, 194, word.example, 20, cellWidth));
          if (word.example_reading) {
            card.push(text(0, 225, word.example_reading, 17, cellWidth));
          }
          if (word.example_translation) {
            card.push(lines(0, 256, word.example_translation, 16, cellWidth, 2));
          }
        }
        parts.push(
          `<g transform="translate(${index * (cellWidth + gap)} 49)">${card.join("")}</g>`,
        );
      }
      if (config.mode === "mixed") {
        const top = 49 + vocabHeight + 14;
        parts.push(
          `<line x1="0" y1="${top}" x2="${width}" y2="${top}" stroke="black" stroke-width="1"/>`,
        );
        parts.push(
          `<g transform="translate(0 ${top + 8})">${grammarSvg(data.grammar, width, height - top - 8)}</g>`,
        );
      }
    }
    return `<g transform="translate(${padding} ${padding})">${parts.join("")}</g>`;
  },
});
