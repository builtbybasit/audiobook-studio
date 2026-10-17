// What the page and the ledger know about a speech provider without a request, shared by browser
// and server (so no state, no browser- or server-only imports). Building and reading requests is
// in `server/providers/speech/`.
import type { AudioFormat, ExpressionTag, SampleRate, TagBracket } from "@/types";

/** `compatible` is anything else, taken as OpenAI's. */
export type SpeechProviderId =
  | "fish"
  | "openai"
  | "gemini"
  | "elevenlabs"
  | "breezeblue"
  | "minimax"
  | "cartesia"
  | "qwen"
  | "breezecpp"
  | "simulated"
  | "compatible";

export interface FormatSupport {
  format: AudioFormat;
  label: string;
  /**
   * Null when the API takes no rate at all (OpenAI answers at the model's own), so an endpoint of
   * that shape must leave its rate unset.
   */
  rates: readonly SampleRate[] | null;
  /** Hz, when no rate is named; null when the provider does not say */
  defaultRate: number | null;
  /** as the API spells them; empty when there is no choice */
  bitrates: readonly { value: number; label: string }[];
  defaultBitrate: number | null;
}

/**
 * How a model's docs say it takes inline expression tags; the Expressions tab starts from this
 * and the person may change it. A model whose docs name none has `null`.
 */
export interface TagSyntax {
  brackets: readonly TagBracket[];
  /** any words go in the brackets, not only a fixed set */
  open: boolean;
  /** the kinds this model takes inline */
  kinds: readonly ExpressionTag["kind"][];
  /** e.g. `[laughs]` */
  example: string;
  /** for the Expressions tab */
  hint: string;
  /**
   * A pause tag for some seconds, from the docs: clamped to their longest, or the nearer of
   * `fixedPauses`; null when no tag stands for it. Without a tag a pause is silence between parts.
   */
  pause?: (seconds: number) => string | null;
  /** the docs take a pause only between words, never at the start or end of the text */
  pauseInside?: boolean;
}

/** At most two decimals, no trailing zeros. */
export const pauseSecs = (seconds: number): string => String(Number(seconds.toFixed(2)));

/**
 * Short vs long fixed pause tag: halfway between the book's default lengths (0.4 s, 1 s), since
 * no provider's docs give a length for theirs.
 */
export const FIXED_PAUSE_SPLIT = 0.7;

/** Null for a long pause the provider lacks. */
export const fixedPauses =
  (short: string, long: string | null) =>
  (seconds: number): string | null =>
    seconds < FIXED_PAUSE_SPLIT ? short : long;

export interface SpeechProviderShape {
  id: SpeechProviderId;
  label: string;
  /** the fallback says yes to anything */
  matches: (baseUrl: string) => boolean;
  /**
   * The path after the base URL, as the Connection tab shows it. A path that carries the voice
   * puts `voice` in it, already escaped, or `<voice>` when there is none.
   */
  requestPath(model: string, voice?: string): string;
  formats: readonly FormatSupport[];
  tags(model: string): TagSyntax | null;
  /**
   * Whether a refused or unanswered request is charged (4xx/5xx after retries, timeout, refusal
   * inside a 200); an unusable 2xx is always billed. False unless the provider's docs say so.
   */
  billsFailures: boolean;
  /** the model ids the provider's docs name; empty when none worth holding to */
  models: readonly string[];
  /** Null when the provider has no voice-cloning API; else its wire module has a `clone`. */
  cloning: CloneSupport | null;
  /** The speed the request can carry for this model, from the provider's docs; null = none. */
  speed(model: string): SpeedRange | null;
}

/** A multiplier: 1 is the voice's own pace, above 1 faster. */
export interface SpeedRange {
  min: number;
  max: number;
}

/**
 * The rate and bitrate sent when an endpoint names none. The server reads them here so what the
 * page shows and what is sent cannot drift apart.
 */
export function formatDefaults(
  shape: Pick<SpeechProviderShape, "formats">,
  format: AudioFormat,
): { rate: number | null; bitrate: number | null } {
  const support = shape.formats.find((f) => f.format === format) ?? shape.formats[0];
  return { rate: support.defaultRate, bitrate: support.defaultBitrate };
}

// ---------- voice cloning ----------

/** Read from a sample's first bytes (`sniffSample` on the server), not its name. */
export type SampleFormat = "wav" | "mp3" | "m4a" | "opus" | "flac";

/** What the provider's docs allow a clone to be made from; the server refuses anything else. */
export interface CloneSupport {
  /** never more than `MAX_VOICE_SAMPLES` */
  maxSamples: number;
  /** bytes; never more than the server's own 20 MB */
  maxSampleBytes: number;
  formats: readonly SampleFormat[];
  /** The only models a voice can be cloned for (a Qwen voice is for one model). Absent: any. */
  models?: readonly string[];
  /** Fish and Qwen transcribe a sample themselves, so for them it is optional. */
  transcript: "none" | "optional" | "required";
  /** The provider's own advice on samples, from its docs, for the Voices tab. */
  advice: string;
  /** The docs' sentence on what making a voice costs; null when free or unsaid. */
  cost: string | null;
  /** For the usage ledger; null when free or unsaid (a plan's slots are not a charge). */
  fee: CloneFee | null;
  /**
   * Offered only on an endpoint that says its server makes voices (`makesVoices`): the compatible
   * shape covers every unknown server, most of which make none.
   */
  optIn?: boolean;
}

export interface CloneFee {
  /** null when priced in the provider's own credits */
  usd: number | null;
  /** "first-use": a voice never spoken with is never charged for */
  when: "made" | "first-use";
  /** in the docs' own words: "$0.01 a voice", "100 credits a voice" */
  said: string;
}

// ---------- the brackets a tag is written in ----------

/**
 * Each bracket's whole-tag form: up to 80 characters, one line, nothing nested. `<…>` also holds
 * documented markup such as `<#0.5#>` and `<break time="1s"/>`.
 */
export const BRACKETS: Record<TagBracket, { open: string; close: string; form: RegExp }> = {
  round: { open: "(", close: ")", form: /^\((?=[^)]*[^\s)])[^()\r\n]{1,80}\)$/ },
  square: { open: "[", close: "]", form: /^\[(?=[^\]]*[^\s\]])[^\]\r\n[]{1,80}\]$/ },
  angle: { open: "<", close: ">", form: /^<(?=[^>]*[^\s>])[^<>\r\n]{1,80}>$/ },
};
