export interface StudyWord {
  word: string;
  reading: string;
  translation: string;
  romaji?: string;
  level?: string;
  example?: string;
  example_reading?: string;
  example_translation?: string;
  tags?: string;
}

/** Original starter collections, not official or exhaustive JLPT lists. */
const n5: [string, string, string, string][] = [
  ["食べる", "たべる", "to eat", "taberu"],
  ["飲む", "のむ", "to drink", "nomu"],
  ["見る", "みる", "to see; to watch", "miru"],
  ["行く", "いく", "to go", "iku"],
  ["来る", "くる", "to come", "kuru"],
  ["する", "する", "to do", "suru"],
  ["読む", "よむ", "to read", "yomu"],
  ["書く", "かく", "to write", "kaku"],
  ["聞く", "きく", "to listen; to ask", "kiku"],
  ["話す", "はなす", "to speak", "hanasu"],
  ["買う", "かう", "to buy", "kau"],
  ["寝る", "ねる", "to sleep", "neru"],
  ["起きる", "おきる", "to wake up", "okiru"],
  ["勉強する", "べんきょうする", "to study", "benkyou suru"],
  ["人", "ひと", "person", "hito"],
  ["友達", "ともだち", "friend", "tomodachi"],
  ["先生", "せんせい", "teacher", "sensei"],
  ["学生", "がくせい", "student", "gakusei"],
  ["学校", "がっこう", "school", "gakkou"],
  ["家", "いえ", "house; home", "ie"],
  ["水", "みず", "water", "mizu"],
  ["お茶", "おちゃ", "tea", "ocha"],
  ["ご飯", "ごはん", "rice; meal", "gohan"],
  ["本", "ほん", "book", "hon"],
  ["今日", "きょう", "today", "kyou"],
  ["明日", "あした", "tomorrow", "ashita"],
  ["昨日", "きのう", "yesterday", "kinou"],
  ["朝", "あさ", "morning", "asa"],
  ["夜", "よる", "night", "yoru"],
  ["毎日", "まいにち", "every day", "mainichi"],
  ["大きい", "おおきい", "big", "ookii"],
  ["小さい", "ちいさい", "small", "chiisai"],
  ["新しい", "あたらしい", "new", "atarashii"],
  ["古い", "ふるい", "old", "furui"],
  ["暑い", "あつい", "hot (weather)", "atsui"],
  ["寒い", "さむい", "cold (weather)", "samui"],
];

const travel: [string, string, string, string][] = [
  ["駅", "えき", "station", "eki"],
  ["電車", "でんしゃ", "train", "densha"],
  ["空港", "くうこう", "airport", "kuukou"],
  ["切符", "きっぷ", "ticket", "kippu"],
  ["入口", "いりぐち", "entrance", "iriguchi"],
  ["出口", "でぐち", "exit", "deguchi"],
  ["右", "みぎ", "right", "migi"],
  ["左", "ひだり", "left", "hidari"],
  ["地図", "ちず", "map", "chizu"],
  ["予約", "よやく", "reservation", "yoyaku"],
  ["部屋", "へや", "room", "heya"],
  ["お手洗い", "おてあらい", "restroom", "otearai"],
  ["お会計", "おかいけい", "the bill; checkout", "okaikei"],
  ["現金", "げんきん", "cash", "genkin"],
  ["病院", "びょういん", "hospital", "byouin"],
  ["薬", "くすり", "medicine", "kusuri"],
  ["助けて", "たすけて", "Help!", "tasukete"],
  ["すみません", "すみません", "Excuse me; I'm sorry", "sumimasen"],
  ["ありがとうございます", "ありがとうございます", "Thank you (polite)", "arigatou gozaimasu"],
  ["お願いします", "おねがいします", "Please; a polite request", "onegaishimasu"],
  ["いくら", "いくら", "how much", "ikura"],
  ["どこ", "どこ", "where", "doko"],
  ["アレルギー", "あれるぎー", "allergy", "arerugii"],
  ["大丈夫", "だいじょうぶ", "all right; okay", "daijoubu"],
];

function words(rows: [string, string, string, string][], level?: string): StudyWord[] {
  return rows.map(([word, reading, translation, romaji]) => ({
    word,
    reading,
    translation,
    romaji,
    ...(level === undefined ? {} : { level }),
  }));
}

export const VOCABULARY = { n5: words(n5, "N5"), travel: words(travel) };

export interface GrammarLesson {
  title: string;
  topic: "polite" | "past" | "particles";
  starter: boolean;
  explanation: string;
  pattern: string;
  example: string;
  reading: string;
  translation: string;
}

export const GRAMMAR: GrammarLesson[] = [
  {
    title: "ます: polite non-past",
    topic: "polite",
    starter: true,
    explanation: "Use the verb's stem + ます for polite habits or future actions.",
    pattern: "食べる → 食べます",
    example: "毎日、ご飯を食べます。",
    reading: "まいにち、ごはんをたべます。",
    translation: "I eat rice every day.",
  },
  {
    title: "Making the ます stem",
    topic: "polite",
    starter: false,
    explanation: "Ichidan: drop る. Godan: use the i-row ending. Irregular verbs change.",
    pattern: "食べる → 食べます · 飲む → 飲みます",
    example: "お茶を飲みます。",
    reading: "おちゃをのみます。",
    translation: "I drink tea.",
  },
  {
    title: "Irregular polite verbs",
    topic: "polite",
    starter: false,
    explanation: "する becomes します; 来る (くる) becomes 来ます (きます).",
    pattern: "する → します · 来る → 来ます",
    example: "毎日、日本語を勉強します。",
    reading: "まいにち、にほんごをべんきょうします。",
    translation: "I study Japanese every day.",
  },
  {
    title: "です: polite statements",
    topic: "polite",
    starter: true,
    explanation: "Add です after a noun to make a polite statement.",
    pattern: "名詞 + です",
    example: "私は学生です。",
    reading: "わたしはがくせいです。",
    translation: "I am a student.",
  },
  {
    title: "ません: polite negatives",
    topic: "polite",
    starter: true,
    explanation: "Replace ます with ません to say you do not do something.",
    pattern: "食べます → 食べません",
    example: "肉を食べません。",
    reading: "にくをたべません。",
    translation: "I do not eat meat.",
  },
  {
    title: "ました: polite past",
    topic: "past",
    starter: true,
    explanation: "Replace ます with ました for a completed past action.",
    pattern: "食べます → 食べました",
    example: "昨日、ご飯を食べました。",
    reading: "きのう、ごはんをたべました。",
    translation: "I ate rice yesterday.",
  },
  {
    title: "ませんでした: past negatives",
    topic: "past",
    starter: false,
    explanation: "Use the verb's stem + ませんでした for an action you did not do.",
    pattern: "行きます → 行きませんでした",
    example: "昨日、学校に行きませんでした。",
    reading: "きのう、がっこうにいきませんでした。",
    translation: "I did not go to school yesterday.",
  },
  {
    title: "は: marking the topic",
    topic: "particles",
    starter: true,
    explanation: "は marks what the sentence is about. As a particle, it is pronounced wa.",
    pattern: "話題 + は",
    example: "私は先生です。",
    reading: "わたしはせんせいです。",
    translation: "I am a teacher.",
  },
  {
    title: "を: marking the object",
    topic: "particles",
    starter: false,
    explanation: "を marks the direct object of an action. It is pronounced o.",
    pattern: "目的語 + を + 動詞",
    example: "本を読みます。",
    reading: "ほんをよみます。",
    translation: "I read a book.",
  },
  {
    title: "に: a destination",
    topic: "particles",
    starter: false,
    explanation: "Use に to mark the destination with a verb of movement.",
    pattern: "場所 + に + 行きます",
    example: "明日、東京に行きます。",
    reading: "あした、とうきょうにいきます。",
    translation: "I will go to Tokyo tomorrow.",
  },
];
