// What a speech provider is, written down once for the browser and the server alike.
//
// Each provider this app speaks to directly has one file beside this one saying what the page and
// the ledger need to know about it without a request: how its base URL is recognised, the request
// line the Connection tab shows, the formats it can be asked for, how its models take expression
// tags, whether it bills a request it refused, and the models its docs name. How a request is
// actually built and read is the server's business, one module per provider under
// `server/providers/speech/`; this is the part both sides share, so it holds no state and imports
// nothing that needs a browser or a server.
import type { AudioFormat, ExpressionTag, SampleRate } from "@/types";

/** Every provider there is a description of. `compatible` is anything else, taken as OpenAI's. */
export type SpeechProviderId =
  | "fish"
  | "openai"
  | "gemini"
  | "elevenlabs"
  | "breezeblue"
  | "minimax"
  | "cartesia"
  | "qwen"
  | "simulated"
  | "compatible";

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

/**
 * How a model takes expression tags written into the text it is sent: the shapes a tag may have,
 * which kinds of expression it takes inline at all, and an example the Expressions tab shows. A
 * model that takes none has no syntax (`null`), and a tag configured for it is refused rather than
 * spoken aloud as words.
 */
export interface TagSyntax {
  /** a tag must match one of these whole */
  forms: readonly RegExp[];
  /** the kinds this model takes inline; a delivery it takes elsewhere is not one of them */
  kinds: readonly ExpressionTag["kind"][];
  /** a tag as the provider's docs spell one, e.g. `[laughs]` */
  example: string;
  /** one sentence on where the syntax comes from, for the Expressions tab */
  hint: string;
}

export interface SpeechProviderShape {
  id: SpeechProviderId;
  /** what the page and messages call the API */
  label: string;
  /** whether a base URL is this provider's; the fallback says yes to anything */
  matches(baseUrl: string): boolean;
  /** the path a line is sent to after the base URL, as the Connection tab shows it */
  requestPath(model: string): string;
  formats: readonly FormatSupport[];
  /** how `model` takes expression tags, or null when it takes none */
  tags(model: string): TagSyntax | null;
  /**
   * Whether the provider charges for a request it refused or never answered. A 2xx it then sent
   * something unusable in is always billed; this is the rest — a 4xx or 5xx after the retries, a
   * timeout, a refusal inside a 200. False unless the provider's own docs say otherwise.
   */
  billsFailures: boolean;
  /** the model ids the provider's docs name; empty when they name none worth holding to */
  models: readonly string[];
  /**
   * How the provider makes a voice from someone's samples and keeps it on the account, to be spoken
   * with by id from then on; null when it has no such API, and the Voices tab offers no cloning.
   * A provider with a description here has a `clone` in its wire module, and one without has none.
   */
  cloning: CloneSupport | null;
}

// ---------- voice cloning ----------

/**
 * What a voice sample can be, read from its first bytes (`sniffSample` on the server) rather
 * than from its name. A sample is any audio of the person speaking: recorded, or downloaded.
 */
export type SampleFormat = "wav" | "mp3" | "m4a" | "opus" | "flac";

/**
 * What the provider's docs allow a clone to be made from. The server refuses anything outside it
 * before a request, with the file's own name, and the Voices tab says it above the picker.
 */
export interface CloneSupport {
  /** the most samples one voice is made from; never more than `MAX_VOICE_SAMPLES` */
  maxSamples: number;
  /** the most one sample may be, in bytes; never more than the server's own 20 MB */
  maxSampleBytes: number;
  /** the formats the provider documents for a sample, a subset of what the sniffer knows */
  formats: readonly SampleFormat[];
  /**
   * The only models a voice can be cloned for, when the provider clones for some of its models and
   * not others — a Qwen voice is made for one model and spoken only with it. Absent: any model.
   */
  models?: readonly string[];
  /**
   * The provider's own advice on samples, a sentence or two for the Voices tab: how long, how
   * many, what kind of audio. From its docs, not invented.
   */
  advice: string;
  /**
   * What making the voice costs, or what it starts costing, as the provider's docs put it — a
   * sentence for the Voices tab — or null when the docs say it is free or say nothing.
   */
  cost: string | null;
  /**
   * What the provider charges for a voice, for the usage ledger — or null when its docs say it
   * charges nothing for one, or say nothing (a plan's slots are not a charge).
   */
  fee: CloneFee | null;
}

/** A charge for making a voice, as the provider's docs give it. */
export interface CloneFee {
  /** in US dollars; null when the docs price it in the provider's own credits, which a plan prices */
  usd: number | null;
  /**
   * When it is charged: as the voice is made, or the first time a line is spoken with it — a voice
   * never spoken with is never charged for.
   */
  when: "made" | "first-use";
  /** the fee in the docs' own words, for the ledger row: "$0.01 a voice", "100 credits a voice" */
  said: string;
}

// ---------- tag shapes several providers share ----------

/** `[laughs]`: square brackets around a word or a few, nothing nested. */
export const SQUARE = /^\[(?=[^\]]*\S)[^\]\r\n[]{1,80}\]$/;
/** `(laughs)`: parentheses around a word or a few. */
export const ROUND = /^\((?=[^)]*\S)[^()\r\n]{1,80}\)$/;
/** `<laugh>`: angle brackets around a word or a few, no attributes or slashes. */
export const ANGLE = /^<[a-z][a-z -]{0,79}>$/i;
