// What an endpoint is on the wire: the paths each kind is reached at, the operational defaults a
// request falls back on, and where Fish Audio differs from everyone else.
//
// Split out of `endpoints.ts` because the server calls these providers too, and that file reaches
// for the browser's keyring. Nothing here imports Vue or holds state, so both sides share one copy
// of the rules instead of the server keeping a second that drifts.
import type {
  AudioEncoding,
  AudioFormat,
  Endpoint,
  EndpointKind,
  EndpointOps,
  Gender,
  SampleRate,
  Voice,
} from "@/types";

export const OPS_DEFAULTS: Record<EndpointKind, EndpointOps> = {
  scripting: {
    timeoutSec: 120,
    maxRetries: 3,
    cooldownSec: 10,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
  },
  tts: {
    timeoutSec: 60,
    maxRetries: 2,
    cooldownSec: 8,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
  },
};

/** What each kind appends to the base URL — worth showing, since the two differ. */
export const KIND_PATH: Record<EndpointKind, string> = {
  scripting: "/chat/completions",
  tts: "/audio/speech",
};

/** Fish Audio takes the model in a header and the voice as `reference_id`, so the path everything
 *  else uses does not apply. Kept here so the Connection tab can show the right request line. */
export const isFishAudio = (e: Pick<Endpoint, "baseUrl">): boolean =>
  /(^|\/\/)([a-z0-9-]+\.)*fish\.audio(\/|$)/i.test(e.baseUrl);

export function ttsRequestPath(e: Pick<Endpoint, "baseUrl">): string {
  return isFishAudio(e) ? "/tts" : KIND_PATH.tts;
}

/** Fish Audio serves speech under /v1 but its model catalogue at the host root, so the voice list
 *  cannot just be appended to the base URL the way an OpenAI-compatible /audio/voices can. */
export function fishModelsUrl(baseUrl: string): string {
  return (
    baseUrl
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/v\d+$/, "") + "/model?self=true&page_size=100"
  );
}

// ---------- audio formats ----------

/** One format an endpoint can be asked for, and what may be asked for with it. */
export interface FormatSupport {
  format: AudioFormat;
  label: string;
  /**
   * The rates a request may name with this format, or null when the API takes no rate at all —
   * OpenAI's answers at the model's own, so an endpoint of that shape must leave its rate unset.
   */
  rates: readonly SampleRate[] | null;
  /** what the provider answers at when no rate is named, in Hz; null when it does not say */
  defaultRate: number | null;
  /** the bitrates a request may name, as the API spells them; empty when there is no choice */
  bitrates: readonly { value: number; label: string }[];
  /** the bitrate the provider uses when none is named; null when there is no choice */
  defaultBitrate: number | null;
}

export const FORMAT_LABEL: Record<AudioFormat, string> = { wav: "WAV", mp3: "MP3", opus: "Opus" };
/** What a clip in each format is served as. */
export const AUDIO_MIME: Record<AudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
};
/** The extension a clip in each format is kept under. */
export const AUDIO_EXT: Record<AudioFormat, string> = { wav: "wav", mp3: "mp3", opus: "opus" };

/**
 * Fish Audio's formats, from https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech.
 * Its WAV also goes to 8 kHz, below the 16 kHz this app keeps speech at, and its `pcm` is WAV
 * without the header, so neither is offered. The Opus default is the schema's `-1000` (automatic);
 * the prose note on the same page says 32 kbps, and the schema is what the server is sent.
 */
const FISH_FORMATS: readonly FormatSupport[] = [
  {
    format: "wav",
    label: "WAV · 16-bit PCM, mono",
    rates: [16000, 24000, 32000, 44100],
    defaultRate: 44100,
    bitrates: [],
    defaultBitrate: null,
  },
  {
    format: "mp3",
    label: "MP3 · mono",
    rates: [32000, 44100],
    defaultRate: 44100,
    bitrates: [
      { value: 64, label: "64 kbps" },
      { value: 128, label: "128 kbps" },
      { value: 192, label: "192 kbps" },
    ],
    defaultBitrate: 128,
  },
  {
    format: "opus",
    label: "Opus · mono, in Ogg",
    rates: [48000],
    defaultRate: 48000,
    // Only automatic. The API lists 24, 32, 48 and 64 kbps, but on 2026-09-23 asking for 24 or 32
    // kbps came back at about 272 kbps — five times the size of automatic, which ran near 60 — so
    // offering them would make "smaller" the larger file. Add them back when Fish honours them.
    bitrates: [{ value: -1000, label: "Automatic" }],
    defaultBitrate: -1000,
  },
];

/**
 * OpenAI's `/audio/speech` (`response_format`): it also offers AAC, FLAC and raw PCM, which this
 * app does not keep clips in. It takes no rate and no bitrate; the answer is at the model's own.
 */
const OPENAI_FORMATS: readonly FormatSupport[] = (["wav", "mp3", "opus"] as const).map(
  (format) => ({
    format,
    label: FORMAT_LABEL[format],
    rates: null,
    defaultRate: null,
    bitrates: [],
    defaultBitrate: null,
  }),
);

/** The formats a speech endpoint can be asked for, by the API its base URL speaks. */
export function speechFormats(e: Pick<Endpoint, "baseUrl">): readonly FormatSupport[] {
  return isFishAudio(e) ? FISH_FORMATS : OPENAI_FORMATS;
}

/** What an endpoint asks for: its own choice, or WAV when it has made none. */
export const encodingOf = (e: Pick<Endpoint, "encoding">): AudioEncoding =>
  e.encoding ?? { format: "wav" };

/**
 * Why this endpoint's format, bitrate and rate cannot be asked for together — empty when they can.
 * The page shows these beside the fields; the server refuses a line with the first of them rather
 * than sending a request the provider would refuse or quietly answer differently.
 */
export function encodingProblems(
  e: Pick<Endpoint, "baseUrl" | "encoding" | "sampleRate">,
): string[] {
  const { format, bitrate } = encodingOf(e);
  const support = speechFormats(e).find((f) => f.format === format);
  if (!support) return [`This endpoint cannot be asked for ${FORMAT_LABEL[format]}`];
  const problems: string[] = [];
  if (bitrate != null && !support.bitrates.some((b) => b.value === bitrate))
    problems.push(
      support.bitrates.length
        ? `${FORMAT_LABEL[format]} here is ${support.bitrates.map((b) => b.label).join(", ")}`
        : `${FORMAT_LABEL[format]} takes no bitrate here`,
    );
  if (e.sampleRate != null) {
    if (!support.rates)
      problems.push(
        "This API answers at the model's own sample rate and cannot be asked for one; clear it",
      );
    else if (!support.rates.includes(e.sampleRate))
      problems.push(
        `${FORMAT_LABEL[format]} here is ${support.rates.map((r) => `${r / 1000} kHz`).join(", ")}`,
      );
  }
  return problems;
}

// ---------- Fish Audio's voice catalogue ----------
// Here rather than in `endpoints.ts` because the server lists voices too, and this file is the one
// both sides may import. Fish calls a voice a model, and its `_id` is the `reference_id` a line is
// spoken with, so a catalogue entry becomes a voice by keeping that id.

/** One entry of Fish Audio's `GET /model` response. Only the fields a voice list needs are typed;
 *  the real payload also carries covers, samples, like counts and the author's profile. */
export interface FishModel {
  _id: string;
  title: string;
  type?: string;
  state?: string;
  tags?: string[];
  languages?: string[];
  visibility?: string;
}

/** The words among Fish's free-form tags that say a gender, and which. */
const FISH_GENDER_TAGS: Record<string, Gender> = {
  male: "m",
  man: "m",
  boy: "m",
  female: "f",
  woman: "f",
  girl: "f",
};

/** Fish has no gender field — a voice carries free-form tags, and only some of them say. */
function fishGender(tags: string[] = []): Gender {
  const t = tags.map((x) => x.toLowerCase());
  if (t.some((x) => FISH_GENDER_TAGS[x] === "m")) return "m";
  if (t.some((x) => FISH_GENDER_TAGS[x] === "f")) return "f";
  return "?";
}

/** Only a trained text-to-speech model can narrate a line; a voice-conversion model or one still
 *  training cannot, so neither is offered as a voice. */
export const isFishVoice = (m: FishModel): boolean =>
  !!m._id && (m.type ?? "tts") === "tts" && (m.state ?? "trained") === "trained";

/**
 * A title with enough beside it to choose by: its languages, and the first two tags that are not
 * the gender the voice already shows. Public titles repeat a lot — a search for "narrator" answers
 * a dozen voices called Narrator — and these are what tells them apart.
 */
export function fishVoiceLabel(m: FishModel): string {
  const title = m.title?.trim() || m._id;
  const langs = (m.languages ?? []).slice(0, 3).map((l) => l.toUpperCase());
  const hints = (m.tags ?? [])
    .filter((t) => !(t.toLowerCase() in FISH_GENDER_TAGS))
    .slice(0, 2)
    .map((t) => t.toLowerCase());
  const extra = [langs.join("/"), hints.join(", ")].filter(Boolean).join(" · ");
  return extra ? `${title} (${extra})` : title;
}

/** A Fish voice's id *is* the `reference_id` a TTS request quotes, so the `_id` is what to keep.
 *  Anything that cannot narrate is dropped. The label is the bare title unless `labelOf` says
 *  otherwise; the server's list passes `fishVoiceLabel`. */
export function voicesFromFishModels(
  items: FishModel[],
  labelOf: (m: FishModel) => string = (m) => m.title?.trim() || m._id,
): Voice[] {
  return items.filter(isFishVoice).map((m) => ({
    id: m._id,
    label: labelOf(m),
    gender: fishGender(m.tags),
  }));
}

/** Where Fish keeps its model catalogue: the host root, without the `/v1` speech is under. */
export const fishApiRoot = (baseUrl: string): string =>
  baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/, "");
