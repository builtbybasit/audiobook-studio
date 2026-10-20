// What an endpoint is on the wire: paths per kind, operational defaults, which provider a speech
// endpoint speaks, and Fish's voice catalogue. Shared with the server, so no Vue and no state;
// each provider is described in `lib/providers/`.
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

/** In the Endpoints page's order. */
export const ENDPOINT_KINDS = [
  "scripting",
  "tts",
  "transcription",
] as const satisfies readonly EndpointKind[];

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
  transcription: {
    timeoutSec: 60,
    maxRetries: 2,
    cooldownSec: 8,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
  },
};

/** What each kind appends to the base URL. */
export const KIND_PATH: Record<EndpointKind, string> = {
  scripting: "/chat/completions",
  tts: "/audio/speech",
  transcription: "/audio/transcriptions",
};

const speaks =
  (...ids: SpeechProviderId[]) =>
  (e: Pick<Endpoint, "baseUrl" | "server">): boolean =>
    ids.includes(speechProviderOf(e).id);

/** Model in a header, voice as `reference_id`. */
export const isFishAudio = speaks("fish");
/** Speech is a `generateContent` call on the model, answered as JSON. */
export const isGemini = speaks("gemini");
/** Voice in the path, model in the body, keyed by `xi-api-key`. */
export const isElevenLabs = speaks("elevenlabs");
/** ElevenLabs' shape plus an `instructions` field. */
export const isBreezeBlue = speaks("breezeblue");
/** Voice in the path of `/text-to-speech/{voice_id}`. */
export const isElevenLabsShaped = speaks("elevenlabs", "breezeblue");
/** `POST /v1/t2a_v2`, answered with JSON carrying the audio as hex. */
export const isMiniMax = speaks("minimax");
/** `POST /tts/bytes` at the host root, with a `Cartesia-Version` header. */
export const isCartesia = speaks("cartesia");
/** Alibaba's Model Studio (DashScope), by its long-standing host or a workspace's own. */
export const isQwen = speaks("qwen");

/** The path after the base URL, for the Connection tab. */
export const ttsRequestPath = (
  e: Pick<Endpoint, "baseUrl" | "server"> & { model?: string },
): string => speechProviderOf(e).requestPath(e.model ?? "");

/** Fish serves speech under /v1 but its model catalogue at the host root. */
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
export const AUDIO_MIME: Record<AudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
};
export const AUDIO_EXT: Record<AudioFormat, string> = { wav: "wav", mp3: "mp3", opus: "opus" };

export const speechFormats = (e: Pick<Endpoint, "baseUrl" | "server">): readonly FormatSupport[] =>
  speechProviderOf(e).formats;

/** WAV when the endpoint has made no choice. */
export const encodingOf = (e: Pick<Endpoint, "encoding">): AudioEncoding =>
  e.encoding ?? { format: "wav" };

/**
 * Why the format, bitrate and rate cannot be asked for together; empty when they can. The server
 * refuses a line rather than send what the provider would refuse or answer differently.
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
// Fish calls a voice a model; its `_id` is the `reference_id` a line is spoken with.

/** One entry of Fish Audio's `GET /model` response; only the fields a voice list needs. */
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

const FISH_GENDER_TAGS: Record<string, Gender> = {
  male: "m",
  man: "m",
  boy: "m",
  female: "f",
  woman: "f",
  girl: "f",
};

/** Fish has no gender field, only free-form tags. */
function fishGender(tags: string[] = []): Gender {
  const t = tags.map((x) => x.toLowerCase());
  if (t.some((x) => FISH_GENDER_TAGS[x] === "m")) return "m";
  if (t.some((x) => FISH_GENDER_TAGS[x] === "f")) return "f";
  return "?";
}

/** Only a trained text-to-speech model can narrate a line. */
export const isFishVoice = (m: FishModel): boolean =>
  !!m._id && (m.type ?? "tts") === "tts" && (m.state ?? "trained") === "trained";

/** Title plus languages and two non-gender tags: public titles repeat a lot ("Narrator"). */
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

/** Drops anything that cannot narrate. The server's list passes `fishVoiceLabel` as `labelOf`. */
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
 * The first recording at an `https` link on Fish's own hosts (`platform.r2.fish.audio`), so a
 * catalogue entry cannot send the page to fetch from anywhere else.
 */
export function fishSampleOf(m: FishModel): { url: string; text: string } | null {
  for (const s of m.samples ?? []) {
    const url = s.audio?.trim() ?? "";
    if (isFishHosted(url)) return { url, text: s.text?.trim() ?? "" };
  }
  return null;
}

function isFishHosted(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)fish\.audio$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** The host root, without the `/v1` speech is under. */
export const fishApiRoot = (baseUrl: string): string =>
  baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/, "");

// ---------- voice samples ----------

/** One ordinary sentence of narration, the same for every voice. */
export const VOICE_SAMPLE = "The mountain mist thinned as dawn crept over the outer sect grounds.";

/** What the Voices tab's Preview cycles through, each kept once heard: a question, joy, a hush. */
export const SAMPLE_LINES: readonly string[] = [
  VOICE_SAMPLE,
  "Are you sure this is the right road? It looks nothing like the map.",
  "We did it! I can't believe we actually made it in time!",
  "Quiet now. Someone is listening on the other side of the door.",
  "Long ago, before the cities rose, the river had no name at all.",
];

/** The longest line a person may type for a preview. */
export const MAX_SAMPLE_TEXT = 300;
