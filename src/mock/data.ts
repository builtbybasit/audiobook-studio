// PROTOTYPE — mock world. Deterministic pseudo-random so reloads look the same.
import { splitText } from "@/lib/split";
import { speak, silenceOf, DEFAULT_PACING } from "@/lib/speech";
import type { FishModel } from "@/lib/endpoints";
import type {
  Book,
  LexEntry,
  Chapter,
  Character,
  Endpoint,
  ExportItem,
  Gender,
  Segment,
  SegmentAudio,
  SegmentMap,
  SegmentType,
  Voice,
  VoiceRef,
  Volume,
  World,
} from "@/types";

/** A deterministic pseudo-random source; same seed ⇒ same world on every reload. */
type Rng = () => number;

/** One character as written in the seed data, before voices and colours are assigned. */
interface CastSeed {
  name: string;
  aliases: string[];
  gender: Gender;
  description: string;
}

/** The hand-authored source for one book; `makeWorld` expands it into the real entities. */
interface BookSeed {
  id: string;
  title: string;
  author: string;
  count: number;
  cover: [string, string];
  /** [volume name, source file, chapter count] */
  volumes: [string, string, number][];
  cast: CastSeed[];
  /** [name, gender] for walk-on speakers */
  minor: [string, Gender][];
  titles: string[];
  narration: string[];
  thought: Record<string, string[]>;
  dialogue: Record<string, string[]>;
}

// Voices belong to an endpoint (each TTS server exposes its own list). A character stores a voice
// *ref* — `<endpointId>/<voiceId>` — so narration knows which endpoint must render that speaker.
const g = (id: string, gender: Gender, label?: string): Voice => ({
  id,
  gender,
  label: label ?? id,
});
export const OPENAI_VOICES: Voice[] = [
  g("alloy", "n"),
  g("ash", "m"),
  g("ballad", "m"),
  g("coral", "f"),
  g("echo", "m"),
  g("fable", "n"),
  g("onyx", "m"),
  g("nova", "f"),
  g("sage", "f"),
  g("shimmer", "f"),
  g("verse", "m"),
];
export const KOKORO_VOICES: Voice[] = [
  g("af_heart", "f", "Heart"),
  g("af_bella", "f", "Bella"),
  g("af_nicole", "f", "Nicole"),
  g("am_adam", "m", "Adam"),
  g("am_michael", "m", "Michael"),
  g("bf_emma", "f", "Emma"),
  g("bm_george", "m", "George"),
  g("bm_lewis", "m", "Lewis"),
];
export const AZURE_VOICES: Voice[] = [
  g("alloy", "n"),
  g("echo", "m"),
  g("fable", "n"),
  g("onyx", "m"),
  g("nova", "f"),
  g("shimmer", "f"),
];
// what a "Fetch voices from server" call would return for a fresh OpenAI-compatible endpoint (e.g. Kokoro-FastAPI, Orpheus, Piper bridges)
/** What a `GET /model?self=true` would return for a Fish Audio account — the catalogue is the
 *  user's own voice library, so ids are reference_ids and there is no gender field, only tags.
 *  Two entries are unusable on purpose: one is still training, one is a voice-conversion model. */
export const FISH_MODELS: FishModel[] = [
  {
    _id: "fish0000000000000000000000000001",
    title: "Narrator · warm baritone",
    type: "tts",
    state: "trained",
    tags: ["male", "narration", "audiobook"],
    languages: ["en"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000002",
    title: "Young swordsman",
    type: "tts",
    state: "trained",
    tags: ["male", "youth"],
    languages: ["en", "zh"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000003",
    title: "Sect elder",
    type: "tts",
    state: "trained",
    tags: ["male", "elderly"],
    languages: ["zh"],
    visibility: "unlist",
  },
  {
    _id: "fish0000000000000000000000000004",
    title: "Lan’er",
    type: "tts",
    state: "trained",
    tags: ["female", "youth"],
    languages: ["zh"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000005",
    title: "Steward",
    type: "tts",
    state: "trained",
    // no gender tag at all — the picker shows this one as unknown
    tags: ["dry", "officious"],
    languages: ["en"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000006",
    title: "Drowned City narrator (training)",
    type: "tts",
    state: "created",
    tags: ["female"],
    languages: ["en"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000007",
    title: "Voice conversion · test",
    type: "svc",
    state: "trained",
    tags: [],
    languages: ["en"],
    visibility: "private",
  },
];

export const DISCOVERABLE_VOICES: Voice[] = [
  g("tara", "f", "Tara"),
  g("leah", "f", "Leah"),
  g("jess", "f", "Jess"),
  g("leo", "m", "Leo"),
  g("dan", "m", "Dan"),
  g("mia", "f", "Mia"),
  g("zac", "m", "Zac"),
  g("zoe", "f", "Zoe"),
];
export const voiceRef = (epId: string, voiceId: string): VoiceRef => `${epId}/${voiceId}`;

export const DIRECTIONS: string[] = [
  "calm, measured",
  "urgent, breathless",
  "whispered, hesitant",
  "dry, amused",
  "cold and clipped",
  "warm, gentle",
  "rising anger",
  "weary, slow",
  "excited, quick",
  "sarcastic, flat",
  "gravely serious",
  "teasing, light",
  "trembling",
  "commanding",
  "muttered under breath",
];

export const PALETTE: string[] = [
  "#a78bfa",
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#fb923c",
  "#2dd4bf",
  "#f87171",
  "#c084fc",
  "#4ade80",
];

function rng(seed: number): Rng {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const BOOKS: BookSeed[] = [
  {
    id: "cliche",
    title: "The Cliché Cultivation World",
    author: "Unknown Daoist",
    count: 24,
    cover: ["#4c1d95", "#a78bfa"],
    volumes: [
      ["Vol. 1 · Outer Sect", "Cliche Cultivation World - Vol 1.epub", 8],
      ["Vol. 2 · Down the Mountain", "Cliche Cultivation World - Vol 2.epub", 8],
      ["Vol. 3 · The Tournament Arc", "Cliche Cultivation World - Vol 3.epub", 8],
    ],
    cast: [
      {
        name: "Narrator",
        aliases: [],
        gender: "n",
        description: "Narration, thoughts, and every speaker without a voice of their own.",
      },
      {
        name: "Ji Ning",
        aliases: ["Ning", "Junior Brother Ji"],
        gender: "m",
        description:
          "Outer-sect disciple who has read too many cultivation novels and knows exactly which cliché he is living through. Dry, self-aware, secretly earnest.",
      },
      {
        name: "Elder Mo",
        aliases: ["the Elder"],
        gender: "m",
        description:
          "Ancient sect elder with a scroll in one hand and a grudge in the other. Speaks in proverbs; means every one of them.",
      },
      {
        name: "Xiao Lan",
        aliases: ["Lan'er"],
        gender: "f",
        description:
          "Childhood friend from the valley village, sharper than anyone in the sect gives her credit for. Loyal, blunt, tired of waiting.",
      },
      {
        name: "Bai Feng",
        aliases: ["Senior Brother Bai"],
        gender: "m",
        description:
          "Senior brother and designated rival. Loud, handsome, and honestly not that bad once the plot stops making him a villain.",
      },
    ],
    minor: [
      ["Sect Disciple", "m"],
      ["Auctioneer", "m"],
      ["Old Gatekeeper", "m"],
      ["Disciple Wu", "m"],
      ["Madam Qian", "f"],
      ["Guard Captain", "m"],
      ["Pill Merchant", "m"],
      ["Junior Sister Mei", "f"],
      ["Innkeeper", "f"],
      ["Elder Shan", "f"],
      ["Young Master Zhou", "m"],
      ["Bandit Leader", "m"],
      ["Fortune Teller", "?"],
      ["Crane Spirit", "?"],
      ["Servant", "f"],
      ["Beggar", "m"],
    ],
    titles: [
      "The Silent Peak",
      "A Debt of Spirit Stones",
      "The Elder’s Test",
      "Qi Deviation",
      "Seven Paths Down the Mountain",
      "Lan’er Returns",
      "The Auction House",
      "Sword Intent",
      "A Cliché Tournament",
      "Blood on the Jade Steps",
      "Cave of Whispers",
      "The Pill Furnace",
    ],
    narration: [
      "The mountain mist thinned as dawn crept over the outer sect grounds.",
      "Ji Ning folded his hands and waited, counting the cracks in the courtyard stone.",
      "Somewhere below, a bell rang three times.",
      "The elder did not look up from his scroll.",
      "A spirit crane wheeled above the peak, indifferent to the mortals beneath it.",
      "Dust settled in the pill room, thick with the smell of burnt ginseng.",
      "The blade hummed once and went still.",
      "Nobody spoke for a long moment.",
      "Lan’er waited by the gate with her sleeves rolled, as if the mountain owed her an answer.",
    ],
    thought: {
      "Ji Ning": [
        "This is exactly how the stories go, and I hate it.",
        "If I fail here, the whole plot ends in chapter twelve.",
        "Why does everyone in this world talk like a fortune cookie?",
      ],
      "Xiao Lan": ["He is hiding something again.", "The Elder knows more than he says."],
    },
    dialogue: {
      "Ji Ning": [
        "I have not come to fight, Elder.",
        "Give me three days. That is all I ask.",
        "Senior Brother, your sword is on fire.",
        "Fine. Fine! I will take the stupid trial.",
      ],
      "Elder Mo": [
        "The path of cultivation is not a path of shortcuts, child.",
        "Three days. Not an hour more.",
        "You remind me of someone I once buried.",
      ],
      "Xiao Lan": [
        "You promised you would come back before the festival.",
        "Do not look at me like that.",
        "Then we go together, or not at all.",
      ],
      "Bai Feng": [
        "Ha! Junior Brother, you have grown bold.",
        "Step aside. This is a matter between men.",
        "I did not ask for your opinion, Ji Ning.",
      ],
    },
  },
  {
    id: "starforge",
    title: "Ashes of the Starforge",
    author: "M. R. Halloway",
    count: 18,
    cover: ["#7c2d12", "#fb923c"],
    volumes: [["Ashes of the Starforge", "Ashes of the Starforge.epub", 18]],
    cast: [
      {
        name: "Narrator",
        aliases: [],
        gender: "n",
        description: "Narration, thoughts, and every speaker without a voice of their own.",
      },
      {
        name: "Captain Idris Vale",
        aliases: ["Vale", "the Captain"],
        gender: "m",
        description:
          "Salvage captain running on debt and stubbornness. Clipped, decisive, allergic to being told the odds.",
      },
      {
        name: "Ocho",
        aliases: ["the ship"],
        gender: "n",
        description:
          "The ship’s mind. Polite, precise, and increasingly worried about its crew. Never raises its voice; never needs to.",
      },
      {
        name: "Dr. Maren Sato",
        aliases: ["Sato", "Doc"],
        gender: "f",
        description:
          "Ship’s physician and reluctant engineer. Runs the numbers three times and argues with all of them.",
      },
      {
        name: "Envoy Tal",
        aliases: ["the Envoy"],
        gender: "f",
        description:
          "Concord envoy with a diplomat’s smile and a warship’s patience. Every sentence is a negotiation.",
      },
    ],
    minor: [
      ["Deck Officer Ruiz", "m"],
      ["Comms", "?"],
      ["Salvager Two", "f"],
      ["Medic", "f"],
      ["Concord Marine", "m"],
      ["Dockmaster", "m"],
      ["Engineer Pell", "f"],
      ["Cargo AI", "n"],
      ["Pilot Yun", "f"],
      ["Quartermaster", "m"],
    ],
    titles: [
      "Cold Start",
      "The Forge Remembers",
      "Ocho Wakes",
      "Envoy",
      "Slag Orbit",
      "Eleven Minutes of Silence",
      "Sato’s Wager",
      "The Long Burn",
      "Mutiny at Perihelion",
    ],
    narration: [
      "The hull ticked as it cooled, a slow metronome in the dark.",
      "Vale watched the forge star through a scratched viewport, too tired to blink.",
      "The corridor lights came up one by one, hesitant as a rumour.",
      "Something in the cargo bay had begun to hum.",
      "The Envoy’s shuttle docked without a sound.",
      "Sato ran the numbers twice, then a third time, and did not like them any better.",
    ],
    thought: {
      "Captain Idris Vale": [
        "We are not going home. Nobody says it, but the ship knows.",
        "She is lying. The question is which part.",
      ],
      "Dr. Maren Sato": ["Eleven minutes. That is all the margin we have."],
    },
    dialogue: {
      "Captain Idris Vale": [
        "Ocho, give me the burn window.",
        "We do this once. There is no second pass.",
        "I am not asking, Doctor.",
      ],
      Ocho: [
        "Burn window opens in eleven minutes, Captain.",
        "I would advise against that. Strongly.",
        "Hull integrity at sixty-one percent and falling.",
      ],
      "Dr. Maren Sato": [
        "If we burn now we cook the forward tanks.",
        "You want a miracle? Give me an hour.",
        "Fine. But it is your name on the log.",
      ],
      "Envoy Tal": [
        "The Concord does not negotiate with salvagers.",
        "You have something that belongs to us, Captain.",
        "How curious. Your ship is afraid.",
      ],
    },
  },
  {
    id: "drowned",
    title: "Letters from the Drowned City",
    author: "Ines Varga",
    count: 22,
    cover: ["#134e4a", "#2dd4bf"],
    volumes: [
      ["Part One · High Water", "Drowned City 1.epub", 11],
      ["Part Two · What the Tide Keeps", "Drowned City 2.epub", 11],
    ],
    cast: [
      {
        name: "Narrator",
        aliases: [],
        gender: "n",
        description: "Narration, thoughts, and every speaker without a voice of their own.",
      },
      {
        name: "Wren",
        aliases: [],
        gender: "f",
        description:
          "Nineteen, stubborn, still writing letters to someone who left when the water was at the first step. Quiet until she is not.",
      },
      {
        name: "Old Tobiah",
        aliases: ["Tobiah", "the lamplighter"],
        gender: "m",
        description:
          "Lamplighter of the drowned avenue. Rows the last boat. Grumbles like a man who has already said goodbye to the city.",
      },
      {
        name: "The Tidewarden",
        aliases: ["Warden"],
        gender: "f",
        description:
          "Whatever keeps the drowned city’s bargains. Speaks slowly, in terms. Do not agree to anything.",
      },
    ],
    minor: [
      ["Postmistress", "f"],
      ["Ferryman", "m"],
      ["Child", "?"],
      ["Cannery Foreman", "m"],
      ["Bell-ringer", "m"],
      ["Widow Marsh", "f"],
      ["Constable", "m"],
      ["Drowned Voice", "?"],
      ["Fishwife", "f"],
      ["Priest", "m"],
      ["Glassblower", "f"],
      ["Salt Merchant", "m"],
    ],
    titles: [
      "High Water",
      "The Lamplighter’s Ledger",
      "A Letter Unsent",
      "Under the Salt Bridge",
      "What the Tide Keeps",
      "Wren Goes Down",
      "The Warden’s Bargain",
      "Glass and Silt",
      "Last Light on Cannery Row",
      "The Drowned Bell",
      "Ink That Will Not Dry",
    ],
    narration: [
      "The water had reached the third step of the cathedral by morning.",
      "Wren wrote the address twice, then crossed it out.",
      "Lamps flickered along the submerged avenue, green through the murk.",
      "The bell tolled somewhere beneath the harbour.",
      "Tobiah’s boat knocked gently against the drowned lamppost.",
    ],
    thought: {
      Wren: [
        "If I post this, she will know I am still here.",
        "The Warden never blinks. Why have I only noticed now?",
      ],
    },
    dialogue: {
      Wren: [
        "Is it deeper than yesterday?",
        "I need to get to the post office. The real one.",
        "You knew. You knew the whole time.",
      ],
      "Old Tobiah": [
        "Deeper every day, girl. Deeper every day.",
        "Nobody rows past the salt bridge after dark.",
        "Sit down before you tip us both in.",
      ],
      "The Tidewarden": [
        "The city keeps what it is given.",
        "A letter for a name. That is the price.",
        "You may go down, Wren. Coming back is another matter.",
      ],
    },
  },
];

const MINOR_LINES: string[] = [
  "Yes, my lord.",
  "This way, please.",
  "You cannot go in there.",
  "Coin first. Then we talk.",
  "Did you hear that?",
  "It was not me, I swear it.",
  "Move along. Nothing to see.",
  "They say the elder has not slept in a week.",
  "Sold! To the gentleman at the back.",
  "Careful. The steps are wet.",
];

export function makeVolumes(book: BookSeed): Volume[] {
  let from = 1;
  return book.volumes.map(([name, file, n], i) => {
    const v: Volume = { id: i + 1, name, file, from, to: from + n - 1 };
    from += n;
    return v;
  });
}

function makeChapters(book: BookSeed, r: Rng): Chapter[] {
  const list: Chapter[] = [];
  const vols = makeVolumes(book);
  for (let i = 1; i <= book.count; i++) {
    const t = book.titles[(i - 1) % book.titles.length];
    const vol = vols.find((v) => i >= v.from && i <= v.to);
    list.push({
      id: i,
      index: i,
      volumeId: vol?.id ?? 1,
      volumeIndex: vol ? i - vol.from + 1 : i,
      title: i > book.titles.length ? `${t} (II)` : t,
      words: 2200 + Math.floor(r() * 2400),
      scripting: "none",
      scriptingProgress: 0,
      narration: "none",
      narrationProgress: 0,
      duration: 0,
    });
  }
  return list;
}

export function generateSegments(
  bookId: string,
  chapterId: number,
  opts: { aliasNoise?: boolean } = {},
): Segment[] {
  const book = BOOKS.find((b) => b.id === bookId)!;
  const r = rng(bookId.length * 977 + chapterId * 131);
  const speakers = Object.keys(book.dialogue);
  const n = 24 + Math.floor(r() * 14);
  const segs: { type: SegmentType; speaker: string; text: string }[] = [];
  let last: string | null = null;
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.42 || i === 0) {
      // real scripts have long descriptive paragraphs; about a quarter of narration runs 300–1200 chars (mock lines are short, so several are joined)
      const paras = r() < 0.25 ? 3 + Math.floor(r() * 10) : 1;
      segs.push({
        type: "narration",
        speaker: "Narrator",
        text: Array.from({ length: paras }, () => pick(book.narration, r)).join(" "),
      });
    } else if (roll < 0.55) {
      const who = pick(Object.keys(book.thought), r);
      segs.push({ type: "thought", speaker: who, text: pick(book.thought[who], r) });
    } else if (roll < 0.66 && book.minor.length) {
      const [who] =
        book.minor[
          Math.floor(r() * Math.min(book.minor.length, 4 + (chapterId % book.minor.length)))
        ];
      segs.push({ type: "dialogue", speaker: who, text: pick(MINOR_LINES, r) });
    } else {
      let who = pick(speakers, r);
      if (who === last) who = pick(speakers, r);
      last = who;
      let speaker = who;
      // occasionally the LLM emits an alias as its own speaker — gives the review UI something to merge
      const aliases = book.cast.find((c) => c.name === who)?.aliases ?? [];
      if (opts.aliasNoise && aliases.length && r() < 0.18) speaker = aliases[0];
      segs.push({ type: "dialogue", speaker, text: pick(book.dialogue[who], r) });
    }
  }
  return segs.map((s, i) => ({
    id: i + 1,
    ...s,
    direction:
      s.type === "narration" ? (r() < 0.3 ? pick(DIRECTIONS, r) : "") : pick(DIRECTIONS, r),
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  }));
}

function pick<T>(arr: T[], r: Rng): T {
  return arr[Math.floor(r() * arr.length)];
}

export function makeWorld(): World {
  const books: Book[] = [];
  const chapters: Record<string, Chapter[]> = {};
  const characters: Record<string, Character[]> = {};
  const segments: SegmentMap = {};
  const r = rng(42);

  // Each endpoint carries its own voice list and a per-request character limit (many small TTS
  // servers degrade or truncate past a few hundred chars; OpenAI caps at 4096). 0 = no limit.
  const endpoints: Endpoint[] = [
    {
      id: "openai",
      name: "OpenAI (main)",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      concurrency: 3,
      enabled: true,
      latency: 1400,
      failRate: 0.01,
      price: 12,
      billing: { unit: "chars", rate: 12 },
      credentialId: "openai-personal",
      quotaGroup: "openai-account",
      spendLimit: 5,
      needsKey: true,
      maxChars: 4096,
      splitAt: "sentence",
      voices: OPENAI_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 30 }, (_, i) => ({
        t: Date.now() - (30 - i) * 60000,
        ms: 1100 + Math.round(Math.sin(i / 3) * 300 + (i % 7) * 60),
        ok: i % 11 !== 4,
      })),
      failures: 2,
      rateLimits: 1,
      backoffUntil: 0,
    },
    {
      id: "local",
      name: "Local Kokoro",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      concurrency: 2,
      enabled: true,
      latency: 2600,
      failRate: 0.025,
      price: 0,
      billing: { unit: "chars", rate: 0 },
      needsKey: false,
      maxChars: 500,
      splitAt: "sentence",
      voices: KOKORO_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 30 }, (_, i) => ({
        t: Date.now() - (30 - i) * 60000,
        ms: 2200 + Math.round(Math.cos(i / 4) * 500 + (i % 5) * 90),
        ok: i % 6 !== 2,
      })),
      failures: 5,
      rateLimits: 0,
      backoffUntil: 0,
    },
    {
      id: "proxy",
      name: "Azure proxy",
      baseUrl: "https://tts-proxy.internal/v1",
      model: "tts-1-hd",
      concurrency: 1,
      enabled: false,
      latency: 1900,
      failRate: 0.05,
      price: 15,
      // billed on the audio it returns, and the rate card was never written down — the page shows
      // this as "unknown", never as free
      billing: { unit: "minute", rate: null },
      credentialId: "proxy-work",
      needsKey: true,
      maxChars: 3000,
      splitAt: "clause",
      voices: AZURE_VOICES.map((v) => ({ ...v })),
      history: [],
      failures: 0,
      rateLimits: 0,
      backoffUntil: 0,
    },
  ];
  const oa = (v: string): VoiceRef => voiceRef("openai", v);
  const kk = (v: string): VoiceRef => voiceRef("local", v);
  // seeded casting: OpenAI for dialogue, the free local Kokoro for the Narrator on two books (cheap
  // narration, premium dialogue); one Drowned character sits on the paused Azure proxy → a blocker to fix.
  const seedVoice: Record<Gender, string[]> = {
    m: ["onyx", "echo", "ash", "ballad", "verse"],
    f: ["nova", "shimmer", "coral", "sage"],
    n: ["alloy", "fable"],
    "?": ["alloy"],
  };
  const narratorVoice: Record<string, VoiceRef> = {
    cliche: kk("bm_george"),
    starforge: oa("sage"),
    drowned: kk("bf_emma"),
  };
  // A book's pronunciation dictionary. These are the names a TTS engine reliably gets wrong; the
  // prose keeps the author's spelling and only the request carries the respelling.
  const lexicon: Record<string, LexEntry[]> = {
    cliche: [
      { id: 1, term: "Ji Ning", say: "Jee Ning", ipa: "dʒiː nɪŋ", enabled: true },
      { id: 2, term: "Lan’er", say: "Lahn-urr", enabled: true, note: "one name, not two words" },
      {
        id: 3,
        term: "Qi",
        say: "chee",
        enabled: false,
        matchCase: true,
        note: "off: the chapter titles read fine, and lower-case “qi” is rare",
      },
    ],
    starforge: [{ id: 1, term: "Ocho", say: "Oh-cho", enabled: true }],
    drowned: [{ id: 1, term: "Tobiah", say: "Toe-BYE-uh", enabled: true }],
  };
  /** rendered length of a chapter: the clips plus the silence stitched between them */
  const timeOf = (segs: Segment[]): number =>
    segs.reduce((a, s) => a + s.audio.duration, 0) + silenceOf(segs, DEFAULT_PACING);
  const seedCuts = (text: string, ep: Endpoint) => {
    const cuts = splitText(text, ep.maxChars, ep.splitAt);
    return cuts.length > 1
      ? {
          parts: cuts.length,
          splitAt: ep.splitAt,
          cuts: cuts.map((c) => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback })),
        }
      : {};
  };
  const seedAudit = (bookId: string, s: Segment, ep: Endpoint, i: number) => {
    const cast = characters[bookId];
    const c = cast.find((x) => x.name === s.speaker);
    const ref = (c?.voice || cast.find((x) => x.name === "Narrator")!.voice)!;
    const said = speak(s.text, lexicon[bookId] ?? []);
    return {
      voiceRef: ref,
      voice: ref.split("/")[1],
      model: ep.model,
      direction: s.direction,
      style: c?.style ?? "",
      type: s.type,
      text: s.text,
      ...(said.hits.length ? { said: said.text, lex: said.hits.length } : {}),
      at: Date.now() - (3600 + i * 7) * 1000,
      cost: (said.text.length / 1e6) * ep.price,
    };
  };
  const routeOf = (bookId: string, speaker: string): Endpoint => {
    const cast = characters[bookId];
    const ref = (cast.find((c) => c.name === speaker)?.voice ||
      cast.find((c) => c.name === "Narrator")!.voice)!;
    return endpoints.find((e) => e.id === ref.split("/")[0])!;
  };

  for (const b of BOOKS) {
    books.push({
      id: b.id,
      title: b.title,
      author: b.author,
      cover: b.cover,
      addedAt: "2026-08-2" + books.length,
      volumes: makeVolumes(b),
    });
    chapters[b.id] = makeChapters(b, r);
    characters[b.id] = [
      ...b.cast.map((c, i) => ({
        ...c,
        voice:
          c.name === "Narrator"
            ? narratorVoice[b.id]
            : oa(seedVoice[c.gender][i % seedVoice[c.gender].length]),
        style: "",
        color: PALETTE[i % PALETTE.length],
        major: true,
      })),
      ...b.minor.map(([name, gender], i) => ({
        name,
        aliases: [],
        gender,
        description: "",
        voice: null,
        style: "",
        color: PALETTE[(i + 5) % PALETTE.length],
        major: false,
      })),
    ];
  }

  // seed pipeline state so every screen has something to show
  const seed = (bookId: string, scripted: number, narrated: number): void => {
    for (const c of chapters[bookId]) {
      if (c.id <= scripted) {
        c.scripting = "done";
        c.scriptingProgress = 100;
        segments[`${bookId}:${c.id}`] = generateSegments(bookId, c.id);
      }
      if (c.id <= narrated) {
        c.narration = "done";
        c.narrationProgress = 100;
        const segs = segments[`${bookId}:${c.id}`];
        segs.forEach((s, i) => {
          const ep = routeOf(bookId, s.speaker);
          s.audio = {
            status: "done",
            endpoint: ep.id,
            ms: 900 + i * 37,
            duration: s.text.split(" ").length / 2.6,
            ...seedCuts(s.text, ep),
            ...seedAudit(bookId, s, ep, i),
          };
        });
        c.duration = timeOf(segs);
      }
    }
  };
  seed("cliche", 12, 3);
  seed("starforge", 18, 18);
  seed("drowned", 2, 0);
  chapters.drowned[1].scripting = "failed";
  delete segments["drowned:2"];
  chapters.cliche[3].narration = "failed";
  // ch 7 of Cliché: one chunk failed verification and was kept whole as narration
  chapters.cliche[6].scripting = "fallback";
  {
    const segs = segments["cliche:7"];
    const run = segs.slice(9, 15);
    segs.splice(9, 6, {
      id: 0,
      type: "narration",
      speaker: "Narrator",
      text: run.map((x) => (x.type === "dialogue" ? `“${x.text}”` : x.text)).join(" "),
      direction: "",
      fallback: true,
      fallbackCount: 6,
      fallbackMismatch: run[2].text.slice(0, 40),
      audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
    });
    segs.forEach((x, i) => (x.id = i + 1));
  }
  // ch 12 of Cliché: the LLM emitted the alias "Ning" as its own speaker → merge suggestion on the Cast page
  {
    let n = 0;
    for (const seg of segments["cliche:12"])
      if (seg.speaker === "Ji Ning" && n < 3) {
        seg.speaker = "Ning";
        n++;
      }
  }
  characters.cliche.push({
    name: "Ning",
    aliases: [],
    gender: "?",
    description: "",
    voice: null,
    style: "",
    color: PALETTE[7],
    major: false,
    isNew: true,
  });
  // ch 2 of Cliché: two segments edited after narration → stale
  chapters.cliche[1].narration = "stale";
  segments["cliche:2"][3].audio.status = "stale";
  segments["cliche:2"][8].audio.status = "stale";
  segments["cliche:4"].forEach((s, i) => {
    const ep = routeOf("cliche", s.speaker);
    s.audio = {
      status: i % 9 === 4 ? "failed" : "done",
      endpoint: ep.id,
      ms: 800 + i * 20,
      duration: i % 9 === 4 ? 0 : s.text.split(" ").length / 2.6,
      ...seedAudit("cliche", s, ep, i),
      error:
        i % 9 === 4
          ? {
              code: 500,
              message: "server error",
              body: '{"error":{"message":"The server had an error while processing your request.","type":"server_error"}}',
            }
          : undefined,
    };
  });
  // ch 1 of Starforge: a listened-to chapter. Two lines are flagged as bad audio and one of them has
  // already been retaken, so the ledger opens on a take waiting to be compared.
  {
    const segs = segments["starforge:1"];
    const spoken = segs.filter((x) => x.type !== "narration");
    const bad = spoken[1] ?? segs[1];
    const slow = spoken[3] ?? segs[3];
    bad.flag = {
      kind: "pronunciation",
      note: `“${bad.text.split(" ").slice(0, 2).join(" ")}” is read as two words`,
      at: Date.now() - 26 * 60000,
    };
    slow.flag = {
      kind: "pause",
      note: "half a second of silence mid-sentence",
      at: Date.now() - 22 * 60000,
    };
    const retaken = spoken[0] ?? segs[0];
    retaken.flag = {
      kind: "delivery",
      note: "flat — the line is meant to land as a threat",
      at: Date.now() - 31 * 60000,
    };
    // take 2 is rendered and waiting: the ledger opens on a comparison, and until it is accepted the
    // chapter still plays, times and exports take 1
    const first = { ...(retaken.audio as SegmentAudio) };
    retaken.direction = "cold, deliberate";
    // the direction was changed on the line before the retake was asked for, so take 1 is out of date
    retaken.audio = { ...first, status: "stale", n: 1 };
    retaken.candidate = {
      ...first,
      n: 2,
      ms: Math.round(first.ms * 1.1),
      duration: first.duration * 1.18,
      direction: retaken.direction,
      at: Date.now() - 19 * 60000,
    };
    chapters.starforge[0].narration = "stale";
    // pacing set by ear while listening: a beat after the threat lands, none before the answer
    retaken.pause = 1.5;
    if (spoken[1]) spoken[1].pause = 0;
    chapters.starforge[0].duration = timeOf(segs);
  }

  // a chapter worth skipping: translator notes at the end of Drowned City
  const notes = chapters.drowned[chapters.drowned.length - 1];
  notes.title = "Translator’s notes";
  notes.excluded = true;
  notes.words = 900;

  const exports: ExportItem[] = [
    {
      id: 1,
      bookId: "starforge",
      filename: "Ashes of the Starforge.m4b",
      title: "Ashes of the Starforge",
      series: "Ashes of the Starforge",
      volume: null,
      author: "M. R. Halloway",
      narrator: "OpenAI TTS · multi-voice",
      year: 2026,
      description: "",
      chapterIds: chapters.starforge.slice(0, 15).map((c) => c.id),
      chapters: 15,
      duration: chapters.starforge.slice(0, 15).reduce((a, c) => a + c.duration, 0),
      bitrate: 96,
      size: 156,
      createdAt: "2026-09-04 21:14",
      version: 1,
      replaces: null,
      status: "done",
    },
    {
      id: 2,
      bookId: "cliche",
      filename: "The Cliché Cultivation World - Vol. 1.m4b",
      title: "The Cliché Cultivation World · Vol. 1",
      series: "The Cliché Cultivation World",
      volume: { number: 1, name: "Vol. 1 · Outer Sect", of: 3 },
      author: "Unknown Daoist",
      narrator: "OpenAI TTS · multi-voice",
      year: 2026,
      description: "",
      chapterIds: [1],
      chapters: 1,
      duration: chapters.cliche.slice(0, 1).reduce((a, c) => a + c.duration, 0),
      bitrate: 96,
      size: 11,
      createdAt: "2026-09-08 09:02",
      version: 1,
      replaces: null,
      status: "replaced",
    },
    {
      id: 3,
      bookId: "cliche",
      filename: "The Cliché Cultivation World - Vol. 1.m4b",
      title: "The Cliché Cultivation World · Vol. 1",
      series: "The Cliché Cultivation World",
      volume: { number: 1, name: "Vol. 1 · Outer Sect", of: 3 },
      author: "Unknown Daoist",
      narrator: "OpenAI TTS · multi-voice",
      year: 2026,
      description: "",
      chapterIds: [1, 2],
      chapters: 2,
      duration: chapters.cliche.slice(0, 2).reduce((a, c) => a + c.duration, 0),
      bitrate: 96,
      size: 21,
      createdAt: "2026-09-10 18:40",
      version: 2,
      replaces: 2,
      status: "done",
    },
  ];

  const orphan = characters.drowned.filter((c) => c.major && c.name !== "Narrator")[1];
  if (orphan) orphan.voice = voiceRef("proxy", "onyx");

  return { books, chapters, characters, segments, endpoints, exports, lexicon };
}
