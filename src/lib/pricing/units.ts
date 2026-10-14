// What a request is charged on: the components each endpoint kind prices, the speech billing
// models, and the quantities one submitted line is measured in.
import type { BillableUnits, RateComponent, TtsBilling, TtsBillingUnit } from "@/types";

// ---------- what is charged for ----------

/** The app's text→audio model: a clip is `words / 2.6` seconds, a word ~5.5 characters. */
export const AUDIO_CHARS_PER_SECOND = 5.5 * 2.6;
/** The same ratio `tokenEstimate` uses. */
const CHARS_PER_TOKEN = 4;

export const RATE_COMPONENTS: RateComponent[] = [
  "input",
  "cachedInput",
  "cacheWrite",
  "output",
  "speech",
  "textTokens",
  "audioTokens",
];

export const TOKEN_COMPONENTS: RateComponent[] = ["input", "cachedInput", "cacheWrite", "output"];
export const SPEECH_COMPONENTS: RateComponent[] = ["speech", "textTokens", "audioTokens"];

/**
 * The components this billing model prices, in panel order. The one definition every form, panel
 * and receipt reads, so they cannot disagree.
 */
export function speechComponents(unit: TtsBillingUnit): RateComponent[] {
  switch (unit) {
    case "tokens":
      return ["textTokens"];
    case "audio-tokens":
      return ["textTokens", "audioTokens"];
    default:
      return ["speech"];
  }
}

// ---------- speech billing units ----------
// The unit is data: nothing branches on a provider's name.

/** A starting point the Pricing tab can edit: audio tokenisers differ by provider and model. */
export const DEFAULT_AUDIO_TOKENS_PER_SECOND = 25;

export const billsAudioTokens = (unit: TtsBillingUnit): boolean => unit === "audio-tokens";

/** A model with two rates needs both; half a rate card prices nothing. */
export function speechRateKnown(billing: TtsBilling): boolean {
  if (billing.rate == null) return false;
  return !billsAudioTokens(billing.unit) || (billing.audioRate ?? null) != null;
}

/**
 * Rates are not carried across: $15/M characters is not $15/M bytes. The new unit starts unknown;
 * the old one's rates are parked, so switching back restores them.
 */
export function switchBillingUnit(billing: TtsBilling, unit: TtsBillingUnit): TtsBilling {
  if (unit === billing.unit) return billing;
  const parked = { ...billing.parked };
  parked[billing.unit] = {
    rate: billing.rate,
    ...(billing.audioRate !== undefined ? { audioRate: billing.audioRate } : {}),
  };
  const restored = parked[unit];
  delete parked[unit];
  return {
    ...billing,
    unit,
    rate: restored ? restored.rate : null,
    audioRate: restored?.audioRate ?? null,
    ...(unit === "audio-tokens"
      ? { audioTokensPerSecond: billing.audioTokensPerSecond ?? DEFAULT_AUDIO_TOKENS_PER_SECOND }
      : {}),
    parked,
  };
}

// ---------- counting what was actually submitted ----------
// Never `String.length` (UTF-16 units). Fish bills "$15 per million UTF-8 bytes", so Mandarin costs
// three times its character count. Payload limits are `maxChars` in `lib/split.ts`.

export function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Unicode code points, so an emoji is one character. */
export const billableChars = (text: string): number => Array.from(text).length;

/** An estimate: the tokeniser is the provider's. */
const textTokensOf = (text: string): number => Math.ceil(billableChars(text) / CHARS_PER_TOKEN);

export const audioTokensPerSecondOf = (billing: TtsBilling): number =>
  billing.audioTokensPerSecond ?? DEFAULT_AUDIO_TOKENS_PER_SECOND;

/**
 * What one speech request submits: `text` as sent (dictionary applied, tags inserted).
 * `instructions` are billed per `TtsBilling.billsInstructions`.
 */
export interface SubmittedSpeech {
  text: string;
  instructions?: string;
  /** how many calls the line was split into */
  requests?: number;
  /** generated audio, seconds; `0` until the clip lands, never stitched silence */
  audioSeconds?: number;
}

/** Every way a provider might bill it, all kept so history survives a billing-model change. */
export function measureSpeech(sent: SubmittedSpeech, billing: TtsBilling): BillableUnits {
  const instructions = (billing.billsInstructions ?? true) ? (sent.instructions ?? "") : "";
  const all = instructions ? `${sent.text}\n${instructions}` : sent.text;
  const audioSeconds = Math.max(0, sent.audioSeconds ?? 0);
  return {
    chars: billableChars(all),
    bytes: utf8Bytes(all),
    textTokens: textTokensOf(all),
    audioSeconds,
    audioTokens: billsAudioTokens(billing.unit)
      ? Math.round(audioSeconds * audioTokensPerSecondOf(billing))
      : null,
    requests: Math.max(1, sent.requests ?? 1),
    instructionChars: instructions ? billableChars(instructions) : 0,
  };
}

/** A shape to start from, never a claim that a request was free. */
export const noUnits = (): BillableUnits => ({
  chars: 0,
  bytes: 0,
  textTokens: 0,
  audioSeconds: 0,
  audioTokens: null,
  requests: 0,
  instructionChars: 0,
});

export function addUnits(a: BillableUnits, b: BillableUnits): BillableUnits {
  return {
    chars: a.chars + b.chars,
    bytes: a.bytes + b.bytes,
    textTokens: (a.textTokens ?? 0) + (b.textTokens ?? 0),
    audioSeconds: a.audioSeconds + b.audioSeconds,
    audioTokens:
      a.audioTokens == null && b.audioTokens == null
        ? null
        : (a.audioTokens ?? 0) + (b.audioTokens ?? 0),
    requests: a.requests + b.requests,
    instructionChars: a.instructionChars + b.instructionChars,
  };
}

/** The quantity a component is charged on, in its own unit. */
export function quantityFor(
  component: RateComponent,
  unit: TtsBillingUnit,
  units: BillableUnits,
): number {
  if (component === "textTokens") return units.textTokens ?? 0;
  if (component === "audioTokens") return units.audioTokens ?? 0;
  switch (unit) {
    case "chars":
      return units.chars;
    case "bytes":
      return units.bytes;
    case "minute":
      return units.audioSeconds / 60;
    case "request":
      return Math.max(1, units.requests);
    default:
      return units.chars;
  }
}

const perMillionComponent = (component: RateComponent, unit: TtsBillingUnit): boolean =>
  component !== "speech" || (unit !== "minute" && unit !== "request");

export function componentAmount(
  component: RateComponent,
  unit: TtsBillingUnit,
  quantity: number,
  rate: number | null,
): number | null {
  if (rate == null) return null;
  return perMillionComponent(component, unit) ? (quantity / 1e6) * rate : quantity * rate;
}

/** `null` where characters cannot honestly convert: per-request, byte and audio-token rates. */
export function perMillionChars(billing: TtsBilling): number | null {
  if (billing.rate == null) return null;
  switch (billing.unit) {
    case "chars":
      return billing.rate;
    case "tokens":
      return billing.rate / CHARS_PER_TOKEN;
    case "minute":
      return (billing.rate * 1e6) / (AUDIO_CHARS_PER_SECOND * 60);
    case "bytes":
    case "audio-tokens":
    case "request":
      return null;
  }
}
