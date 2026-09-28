// What an endpoint is on the wire: the paths each kind is reached at, the operational defaults a
// request falls back on, and — for a speech endpoint — which provider its base URL speaks.
//
// Split out of `endpoints.ts` because the server calls these providers too, and that file reaches
// for the browser's keyring. Nothing here imports Vue or holds state, so both sides share one copy
// of the rules instead of the server keeping a second that drifts. What each provider is — its
// host, its request line, its formats, its tags — is written down once per provider in
// `lib/providers/`; the helpers here are the questions the pages already ask of it.
import type {
  AudioEncoding,
  AudioFormat,
  Endpoint,
  EndpointKind,
  EndpointOps,
  Gender,
  Voice,
} from "@/types";
import { speechProviderOf, type FormatSupport, type SpeechProviderId } from "@/lib/providers";

export type { FormatSupport } from "@/lib/providers";

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

const speaks =
  (...ids: SpeechProviderId[]) =>
  (e: Pick<Endpoint, "baseUrl">): boolean =>
    ids.includes(speechProviderOf(e).id);

/** Fish Audio takes the model in a header and the voice as `reference_id`, so the path everything
 *  else uses does not apply. Kept here so the Connection tab can show the right request line. */
export const isFishAudio = speaks("fish");
/** Google's Gemini API: speech is a `generateContent` call on the model, answered as JSON. */
export const isGemini = speaks("gemini");
/** ElevenLabs: the voice is in the path and the model in the body, keyed by `xi-api-key`. */
export const isElevenLabs = speaks("elevenlabs");
/** BreezeBlue's hosted API, which copies ElevenLabs' shape and adds an `instructions` field. */
export const isBreezeBlue = speaks("breezeblue");
/** Either API that takes the voice in the path of `/text-to-speech/{voice_id}`. */
export const isElevenLabsShaped = speaks("elevenlabs", "breezeblue");
/** MiniMax: `POST /v1/t2a_v2`, answered with JSON carrying the audio as hex. */
export const isMiniMax = speaks("minimax");
/** Cartesia: `POST /tts/bytes` at the host root, with a `Cartesia-Version` header. */
export const isCartesia = speaks("cartesia");
/** Alibaba's Model Studio (DashScope), by its long-standing host or a workspace's own. */
export const isQwen = speaks("qwen");

/** The path a line is sent to, after the base URL — worth showing, since every provider differs. */
export const ttsRequestPath = (e: Pick<Endpoint, "baseUrl"> & { model?: string }): string =>
  speechProviderOf(e).requestPath(e.model ?? "");

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

export const FORMAT_LABEL: Record<AudioFormat, string> = { wav: "WAV", mp3: "MP3", opus: "Opus" };
/** What a clip in each format is served as. */
export const AUDIO_MIME: Record<AudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
};
/** The extension a clip in each format is kept under. */
export const AUDIO_EXT: Record<AudioFormat, string> = { wav: "wav", mp3: "mp3", opus: "opus" };

/** The formats a speech endpoint can be asked for, by the API its base URL speaks. */
export const speechFormats = (e: Pick<Endpoint, "baseUrl">): readonly FormatSupport[] =>
  speechProviderOf(e).formats;

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
  /** recordings Fish made of the voice; `audio` is a link to an MP3 on its CDN */
  samples?: { title?: string; text?: string; audio?: string }[];
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

/**
 * A Fish model's first recording, when it has one at an `https` link — the only kind the browser is
 * handed to play. Fish's public voices mostly have one; a voice still training has none.
 */
export function fishSampleOf(m: FishModel): { url: string; text: string } | null {
  for (const s of m.samples ?? []) {
    const url = s.audio?.trim() ?? "";
    if (/^https:\/\//i.test(url)) return { url, text: s.text?.trim() ?? "" };
  }
  return null;
}

/** Where Fish keeps its model catalogue: the host root, without the `/v1` speech is under. */
export const fishApiRoot = (baseUrl: string): string =>
  baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/, "");

// ---------- voice cloning ----------

/**
 * Whether this endpoint's provider can make a voice from someone's recordings and keep it as one
 * more voice on the account. Only Fish Audio, so far; the Voices tab offers cloning only here.
 */
export const canCloneVoices = (e: Pick<Endpoint, "baseUrl">): boolean => isFishAudio(e);

/**
 * The most recordings one voice is made from. Fish takes up to twenty; the server refuses more, and
 * the Voices tab keeps the first twenty picked and says so.
 */
export const MAX_CLONE_CLIPS = 20;

// ---------- voice samples ----------

/**
 * What a voice sample says: one ordinary sentence of narration, the same for every voice. The
 * server has the saved endpoint say it, and the demo has the browser's own voice read it.
 */
export const VOICE_SAMPLE = "The mountain mist thinned as dawn crept over the outer sect grounds.";
