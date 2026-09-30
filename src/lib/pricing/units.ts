// What a request is charged on: the components each kind of endpoint prices, the speech billing
// models, and the quantities one submitted line is measured in, whichever of them is billed.
import type { BillableUnits, RateComponent, TtsBilling, TtsBillingUnit } from "@/types";

// ---------- what is charged for ----------

/** The app's own text→audio model, used to convert between characters and audio minutes:
 *  a clip is `words / 2.6` seconds long and a word is ~5.5 characters. */
export const AUDIO_CHARS_PER_SECOND = 5.5 * 2.6;
/** Rough tokeniser ratio, the same one `tokenEstimate` uses. */
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

/** The components of each kind of endpoint, in the order a panel should list them. */
export const TOKEN_COMPONENTS: RateComponent[] = ["input", "cachedInput", "cacheWrite", "output"];
/** Every component a speech card can price, across all billing models. */
export const SPEECH_COMPONENTS: RateComponent[] = ["speech", "textTokens", "audioTokens"];

/**
 * The components **this** billing model prices, in the order a panel should list them.
 *
 * One definition, read by the rate form, the effective-rates panel, the schedule editor, the
 * promotion scopes and the receipt — so a model that bills two things can never end up with a form
 * that edits one of them and a receipt that charges the other.
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
//
// The billing model is the endpoint's, not ours. Everything below takes the unit as data: nothing
// branches on a provider's name, and adding a model that bills on something new means adding it
// here rather than special-casing it at each call site.

/**
 * The default audio-token conversion, used where an endpoint has not set its own.
 *
 * A starting point, not a fact: audio tokenisers differ by provider and by model, so this is what
 * the Pricing tab offers to edit rather than something the arithmetic assumes silently.
 */
export const DEFAULT_AUDIO_TOKENS_PER_SECOND = 25;

/** True when this model charges separately for the audio that comes back. */
export const billsAudioTokens = (unit: TtsBillingUnit): boolean => unit === "audio-tokens";

/**
 * Is this endpoint's rate card complete enough to price a request?
 *
 * A model with two rates needs both: knowing what the text costs and not what the audio costs is
 * not a partial answer, it is no answer, and pretending otherwise puts a confident number under a
 * bill that is going to be larger.
 */
export function speechRateKnown(billing: TtsBilling): boolean {
  if (billing.rate == null) return false;
  return !billsAudioTokens(billing.unit) || (billing.audioRate ?? null) != null;
}

/**
 * Move an endpoint onto a different billing model.
 *
 * The rates are **not** carried across. $15 per million characters is not $15 per million UTF-8
 * bytes and neither is $15 per million audio tokens; carrying the number over would silently
 * reprice the endpoint by a factor nobody chose, which is the one thing a billing-model switch
 * must never do. So the new model starts unknown — the state that reports honestly — and what was
 * configured under the old one is parked rather than discarded, so switching back restores it.
 *
 * Nothing here touches a receipt: requests already recorded keep the model and the rates they were
 * charged under, because a receipt is a fact about the past.
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
//
// Three quantities, three counting rules, and none of them is `String.length`.
//
// `String.length` is UTF-16 code units: it counts an emoji as two and a Han character as one, and
// it is neither what a provider that bills "characters" means nor what one that bills bytes meters.
// Keeping these apart is the whole reason the Fish Audio preset bills in bytes: its price list says
// "$15 per million UTF-8 bytes" even where the surrounding prose says characters, and a chapter of
// Mandarin costs three times what the character count suggests.
//
// None of this is the same question as "does this line fit in one request": that is `maxChars`, it
// is about the endpoint's payload limit rather than its price list, and it lives in `lib/split.ts`.

/** UTF-8 bytes of a string — what a byte-billed provider meters. */
export function utf8Bytes(text: string): number {
  // TextEncoder is the exact answer and is available everywhere this runs; the fallback keeps a
  // pure function pure rather than throwing in an environment that lacks it.
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Billable characters — Unicode code points, so an emoji is one character and not two. */
export const billableChars = (text: string): number => [...text].length;

/** Estimated input text tokens. A tokeniser is the provider's, so this is explicitly an estimate. */
const textTokensOf = (text: string): number => Math.ceil(billableChars(text) / CHARS_PER_TOKEN);

export const audioTokensPerSecondOf = (billing: TtsBilling): number =>
  billing.audioTokensPerSecond ?? DEFAULT_AUDIO_TOKENS_PER_SECOND;

/**
 * What one speech request submits, as the endpoint receives it.
 *
 * `text` is the line **after** the pronunciation dictionary has rewritten it and the expression
 * tags have been inserted — what actually goes over the wire, not what the book says. `instructions`
 * is the voice direction sent beside it, which most providers meter as part of the request and a
 * few ignore; `TtsBilling.billsInstructions` decides which, per endpoint.
 */
export interface SubmittedSpeech {
  text: string;
  instructions?: string;
  /** how many calls the line became against the endpoint's per-request limit */
  requests?: number;
  /** generated audio, seconds — `0` until the clip lands, and never stitched silence */
  audioSeconds?: number;
}

/**
 * Count one submitted request every way a provider might bill it.
 *
 * Every quantity is worked out from the same submitted content, so they cannot drift apart, and all
 * of them are kept whichever model is in force — recording only the billed one would mean an
 * endpoint that changed billing model had no history worth comparing.
 */
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

/** Nothing measured yet — a shape to start from, never a claim that a request was free. */
export const noUnits = (): BillableUnits => ({
  chars: 0,
  bytes: 0,
  textTokens: 0,
  audioSeconds: 0,
  audioTokens: null,
  requests: 0,
  instructionChars: 0,
});

/** Add up what several requests submitted, so a run's estimate counts the same way one clip does. */
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

/** Which measured quantity one component is charged on, in that component's own unit. */
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

/** Is this component priced per million of its unit, or per unit outright? */
const perMillionComponent = (component: RateComponent, unit: TtsBillingUnit): boolean =>
  component !== "speech" || (unit !== "minute" && unit !== "request");

/** One component's charge: quantity × rate, with the per-million divisor where it applies. */
export function componentAmount(
  component: RateComponent,
  unit: TtsBillingUnit,
  quantity: number,
  rate: number | null,
): number | null {
  if (rate == null) return null;
  return perMillionComponent(component, unit) ? (quantity / 1e6) * rate : quantity * rate;
}

/** The per-1M-characters figure the old run estimator worked in.
 *
 *  `null` wherever a character count cannot honestly produce one: a per-request fee has no
 *  character in it, and a byte or token rate over non-ASCII text is a different quantity rather
 *  than a different scale, so quoting one as the other is exactly the conflation this file exists
 *  to prevent. */
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
