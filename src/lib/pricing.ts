// What an endpoint charges right now, why, and what one request cost.
//
// Everything here is pure: given a rate card and an instant it answers the same way every time, and
// it never reads a store or a clock of its own. That is what makes a priced request a receipt — the
// same inputs always produce the same figure, so a receipt can be kept instead of recalculated.
//
// The one rule worth knowing before reading any of it:
//
//   1. Base rates are what the endpoint charges normally.
//   2. The schedule may replace them. **At most one window applies** — the first in the list whose
//      recurrence covers the instant. Windows never stack with each other.
//   3. A promotion may then replace what the schedule left. **At most one promotion applies per
//      component** — the one that makes that component cheapest, ties going to the one ending
//      soonest and then to list order. Promotions never stack, with each other or with themselves.
//
// So a rate is `base → scheduled → promoted`, each step replacing the last rather than compounding.
// `effectiveRates` returns every step, which is what lets the page say *why* a price is what it is.
import {
  DAYS,
  clockLabel,
  localClock,
  localTimezone,
  stamp,
  timezoneValid,
  whenPhrase,
} from "@/lib/wallClock";
import type {
  BillableUnits,
  ChargeLine,
  CostBasis,
  CostLine,
  EffectiveComponent,
  PricedRequest,
  PricingChange,
  PricingConfig,
  PricingSnapshot,
  Promotion,
  PromotionScope,
  QuantitySource,
  RateComponent,
  RateEstimate,
  RateSet,
  RateWindow,
  SpeechCharge,
  SpeechChargeLine,
  SpeechEstimate,
  SpeechUsage,
  SpeechUsageFormat,
  TokenUsage,
  TtsBilling,
  TtsBillingUnit,
  UsageFormat,
  UsageProblem,
} from "@/types";

// ---------- money ----------

/** Money to a sensible number of places: cents for real sums, more for fractions of a cent. */
export function money(n: number): string {
  const abs = Math.abs(n);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  return (
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })
  );
}

/** An unknown cost is never $0. */
export const maybeMoney = (n: number | null | undefined): string =>
  n == null ? "unknown" : money(n);

export const rate = (n: number | null): string => (n == null ? "unknown" : money(n));

/** A per-million-tokens rate, as it is written on every provider's price list. */
export const perMillion = (n: number | null): string => (n == null ? "—" : `${money(n)} / 1M`);

// ---------- what is charged for ----------

/** The app's own text→audio model, used to convert between characters and audio minutes:
 *  a clip is `words / 2.6` seconds long and a word is ~5.5 characters. */
export const AUDIO_CHARS_PER_SECOND = 5.5 * 2.6;
/** Rough tokeniser ratio, the same one `tokenEstimate` uses. */
export const CHARS_PER_TOKEN = 4;

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

export const COMPONENT_LABEL: Record<RateComponent, string> = {
  input: "Input",
  cachedInput: "Cached input",
  cacheWrite: "Cache write",
  output: "Output",
  speech: "Speech",
  textTokens: "Input text tokens",
  audioTokens: "Output audio tokens",
};

export const COMPONENT_HINT: Record<RateComponent, string> = {
  input: "The chapter text, the prompt and any context carried forward.",
  cachedInput: "Input the provider served from its cache instead of reading again.",
  cacheWrite: "Input the provider wrote into its cache for later requests.",
  output: "The script that comes back — lines, speaker labels and directions.",
  speech: "What this endpoint bills for rendering a line — see the unit beside the rate.",
  textTokens:
    "The line as submitted — after pronunciation replacements and expression tags — plus any voice instructions sent with it.",
  audioTokens:
    "The audio that comes back, metered in tokens. Not a conversion of the text: it follows the length of the recording.",
};

export const SCOPE_LABEL: Record<PromotionScope, string> = {
  model: "Whole model",
  input: "Input only",
  cachedInput: "Cached input only",
  cacheWrite: "Cache writes only",
  output: "Output only",
  speech: "Speech rates",
  textTokens: "Input text tokens only",
  audioTokens: "Output audio tokens only",
};

// ---------- speech billing units ----------
//
// The billing model is the endpoint's, not ours. Everything below takes the unit as data: nothing
// branches on a provider's name, and adding a model that bills on something new means adding it
// here rather than special-casing it at each call site.

export const BILLING_UNITS: {
  value: TtsBillingUnit;
  label: string;
  group: string;
  hint: string;
}[] = [
  {
    value: "chars",
    label: "per 1M characters",
    group: "What was sent",
    hint: "billable characters — Unicode code points, not UTF-16 length",
  },
  {
    value: "bytes",
    label: "per 1M UTF-8 bytes",
    group: "What was sent",
    hint: "what Fish Audio meters, even where its price list says “characters”",
  },
  {
    value: "tokens",
    label: "per 1M input text tokens",
    group: "What was sent",
    hint: "the text tokenised, with no separate charge for the audio",
  },
  {
    value: "audio-tokens",
    label: "input text + output audio tokens",
    group: "Tokens both ways",
    hint: "two rates, priced separately — Gemini-style TTS",
  },
  {
    value: "minute",
    label: "per audio minute",
    group: "What came back",
    hint: "billed on the length of the recording",
  },
  {
    value: "request",
    label: "per request",
    group: "Flat fee",
    hint: "a fee per call, regardless of length",
  },
];

export const billingUnitLabel = (unit: TtsBillingUnit): string =>
  BILLING_UNITS.find((b) => b.value === unit)?.label ?? unit;

/** The short suffix a rate field wears, e.g. `$12.00 / 1M chars`. */
export const BILLING_SUFFIX: Record<TtsBillingUnit, string> = {
  chars: "/ 1M chars",
  bytes: "/ 1M UTF-8 bytes",
  tokens: "/ 1M text tokens",
  "audio-tokens": "/ 1M text tokens",
  minute: "/ audio min",
  request: "/ request",
};

/**
 * What the single-rate `speech` component is *called* under each model.
 *
 * "Speech" is the component's name, not a description of what was charged, and a receipt that says
 * "Speech · 59 UTF-8 bytes" when the whole question is which quantity was billed is one word short
 * of answering it. The two token components name themselves already.
 */
export const BILLING_NOUN: Record<TtsBillingUnit, string> = {
  chars: "Characters",
  bytes: "UTF-8 bytes",
  tokens: "Input text tokens",
  "audio-tokens": "Input text tokens",
  minute: "Audio minutes",
  request: "Requests",
};

/** The same, lower-case and in a sentence: "so only the UTF-8 bytes are charged". */
export const BILLING_PHRASE: Record<TtsBillingUnit, string> = {
  chars: "only the characters are charged",
  bytes: "only the UTF-8 bytes are charged — not the characters, and not the tokens",
  tokens: "only the input text tokens are charged",
  "audio-tokens":
    "the input text tokens and the output audio tokens are charged separately, and nothing else is charged at all",
  minute: "only the audio that came back is charged",
  request: "the call is charged as a flat fee, whatever it carried",
};

/** How one charged line is labelled: the component's name, or what this model bills on. */
export const chargeLabel = (c: RateComponent, unit: TtsBillingUnit): string =>
  c === "speech" ? BILLING_NOUN[unit] : COMPONENT_LABEL[c];

/** What each component of a speech card is measured in, spelled out for a quantity column. */
export const COMPONENT_UNIT: Partial<Record<RateComponent, string>> = {
  textTokens: "/ 1M text tokens",
  audioTokens: "/ 1M audio tokens",
};

/**
 * How one component's rate is written.
 *
 * Token components on a scripting card are always per 1M tokens. On a speech card the two token
 * components say **which** tokens, because "$20.00 / 1M" on a Gemini-style endpoint is the answer
 * to a question nobody asked. The single-rate `speech` component is written in whatever unit its
 * endpoint bills in, which is why that unit has to be passed in.
 */
export const rateSuffix = (c: RateComponent, unit?: TtsBillingUnit): string =>
  c === "speech" ? BILLING_SUFFIX[unit ?? "chars"] : (COMPONENT_UNIT[c] ?? "/ 1M tokens");

/** A rate with its unit: `$12.00 / 1M chars`. */
export const rateWithUnit = (n: number | null, c: RateComponent, unit?: TtsBillingUnit): string =>
  n == null ? "unknown" : `${money(n)} ${rateSuffix(c, unit)}`;

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
export const textTokensOf = (text: string): number =>
  Math.ceil(billableChars(text) / CHARS_PER_TOKEN);

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

/**
 * What a speech request costs, given what it submitted and what came back.
 *
 * Every billing model goes through the same two steps — pick the quantity this component is
 * charged on, multiply by its rate — so none of them can quietly acquire arithmetic of its own.
 * `null` = a rate this model needs is not known, which is never the same as free.
 */
export function ttsCost(billing: TtsBilling, units: BillableUnits): number | null {
  const rates = speechRates(billing);
  let total = 0;
  for (const c of speechComponents(billing.unit)) {
    const amount = componentAmount(c, billing.unit, quantityFor(c, billing.unit, units), rates[c]);
    if (amount == null) return null;
    total += amount;
  }
  return total;
}

/**
 * Does this promotion touch this component?
 *
 * `speech` is the speech side as a whole rather than one named component: a promotion written when
 * an endpoint billed per character still discounts it after it moves to token billing, which is
 * the reading an operator means by "20% off speech". `textTokens` and `audioTokens` target one half.
 */
const inScope = (p: Promotion, c: RateComponent): boolean =>
  p.scope.includes("model") ||
  p.scope.includes(c) ||
  (p.scope.includes("speech") && (c === "textTokens" || c === "audioTokens"));

/**
 * Does this promotion, as written, reach this scope on a card with these components?
 *
 * Not the same question as "is this string in `scope`". A speech card with one rate offers only
 * "whole model", and a promotion scoped to `speech` covers the whole of that card — so the control
 * has to read as on. Asking membership instead showed an applied promotion with nothing selected,
 * which invites somebody to "fix" it and change what it covers.
 */
export function scopeActive(
  p: Promotion,
  scope: PromotionScope,
  components: RateComponent[],
): boolean {
  if (p.scope.includes(scope)) return true;
  if (scope === "model") return components.length > 0 && components.every((c) => inScope(p, c));
  return inScope(p, scope);
}

// ---------- configuration ----------

export const newPricing = (over: Partial<PricingConfig> = {}): PricingConfig => ({
  cachedInput: null,
  cacheWrite: null,
  timezone: localTimezone(),
  windows: [],
  promotions: [],
  ...over,
});

/**
 * The pricing block as it stands, **without** writing one.
 *
 * `ensurePricing` fills a missing block in, which is right when a form is about to edit it and
 * wrong everywhere else: an endpoint with no advanced pricing at all is a real state, and a
 * read-only caller that quietly gives it an empty schedule has changed the endpoint by looking at
 * it. Pricing something is a read, so it comes through here.
 */
export function readPricing(p: { pricing?: PricingConfig }): PricingConfig {
  return p.pricing ?? newPricing({ timezone: "UTC" });
}

/** Fill in the pricing block on a profile saved before it existed. Idempotent. */
export function ensurePricing<T extends { pricing?: PricingConfig }>(p: T): PricingConfig {
  if (!p.pricing) p.pricing = newPricing();
  const c = p.pricing;
  if (c.cachedInput === undefined) c.cachedInput = null;
  if (c.cacheWrite === undefined) c.cacheWrite = null;
  if (!c.timezone) c.timezone = localTimezone();
  if (!Array.isArray(c.windows)) c.windows = [];
  if (!Array.isArray(c.promotions)) c.promotions = [];
  return c;
}

/** What `baseRates` and `pricingOf` need off an endpoint — every scripting profile satisfies it. */
export interface Priced {
  inPrice: number;
  outPrice: number;
  pricing?: PricingConfig;
}

/** The base rate card of an LLM endpoint: the two rates on the profile, plus the two cache rates. */
export const baseRates = (p: Priced): RateSet => ({
  input: p.inPrice,
  output: p.outPrice,
  cachedInput: p.pricing?.cachedInput ?? null,
  cacheWrite: p.pricing?.cacheWrite ?? null,
  speech: null,
  textTokens: null,
  audioTokens: null,
});

/** The whole rate card of an LLM endpoint, ready to be evaluated at any instant. */
export const pricingOf = (p: Priced): { base: RateSet; config: PricingConfig } => ({
  base: baseRates(p),
  config: ensurePricing(p),
});

/**
 * The base rate card of a speech endpoint: one rate, in that endpoint's own unit.
 *
 * A rate that is not known stays `null` through every window and promotion — a discount on an
 * unknown price is still an unknown price, and this is where that is guaranteed rather than
 * remembered.
 */
export function speechRates(billing: TtsBilling): RateSet {
  const priced = new Set(speechComponents(billing.unit));
  return {
    input: null,
    output: null,
    cachedInput: null,
    cacheWrite: null,
    // A component this model does not price stays `null` — not `0` — so no window, promotion or
    // total can invent a charge for something the endpoint does not bill for.
    speech: priced.has("speech") ? billing.rate : null,
    textTokens: priced.has("textTokens") ? billing.rate : null,
    audioTokens: priced.has("audioTokens") ? (billing.audioRate ?? null) : null,
  };
}

/** The whole rate card of a speech endpoint. `billing` carries the unit its rate is written in. */
export const speechPricingOf = (e: {
  billing: TtsBilling;
  pricing?: PricingConfig;
}): { base: RateSet; config: PricingConfig; unit: TtsBillingUnit } => ({
  base: speechRates(e.billing),
  config: ensurePricing(e),
  unit: e.billing.unit,
});

/**
 * The dearest rate any **input** token could be charged at.
 *
 * Cached and cache-write tokens are slices of the input, not additions to it, and neither is
 * guaranteed to be cheaper than ordinary input — a cache write commonly costs *more*, and this app
 * defaults a new one to 125% of the input rate. So "every input token at the ordinary rate" is not
 * an upper bound on anything, and a reservation worked out that way can be overshot by the very
 * first request. A budget reserves at this rate instead, which nothing can exceed.
 *
 * `null` only when the card prices no input component at all.
 */
export function dearestInput(
  rates: Pick<RateSet, "input" | "cachedInput" | "cacheWrite">,
): number | null {
  const xs = [rates.input, rates.cachedInput, rates.cacheWrite].filter(
    (x): x is number => x != null,
  );
  return xs.length ? Math.max(...xs) : null;
}

/** True when ordinary input really is the dearest way an input token can be charged. */
export const inputIsDearest = (
  rates: Pick<RateSet, "input" | "cachedInput" | "cacheWrite">,
): boolean => rates.input != null && (dearestInput(rates) ?? rates.input) <= rates.input + EPSILON;

/** True when this window runs past midnight — the case that is wrong everywhere it isn't tested. */
export const crossesMidnight = (w: RateWindow): boolean => w.to <= w.from;

/** Does a window cover this local instant? */
export function windowCovers(w: RateWindow, day: number, minutes: number): boolean {
  const onDay = (d: number) => !w.days.length || w.days.includes(d);
  if (!crossesMidnight(w)) return onDay(day) && minutes >= w.from && minutes < w.to;
  // the day list names the day the window *starts* on, so the tail past midnight belongs to it
  if (onDay(day) && minutes >= w.from) return true;
  return onDay((day + 6) % 7) && minutes < w.to;
}

export function windowLabel(w: RateWindow): string {
  const days = !w.days.length
    ? "every day"
    : w.days.length === 7
      ? "every day"
      : w.days
          .slice()
          .sort((a, b) => a - b)
          .map((d) => DAYS[d])
          .join(", ");
  const span = `${clockLabel(w.from)}–${clockLabel(w.to)}${crossesMidnight(w) ? " (next day)" : ""}`;
  return `${days} ${span}`;
}

// ---------- effective rates ----------

const applyPercent = (n: number | null, percent: number): number | null =>
  n == null ? null : Math.max(0, n * (1 - percent / 100));

const pct = (percent: number): string =>
  `${Number(percent.toFixed(2))}% ${percent < 0 ? "surcharge" : "off"}`;

/** `${label} · 50% off` reads badly when the label is already "50% off gpt-4o-mini". */
const reason = (label: string, percent: number): string =>
  label.includes(`${Number(percent.toFixed(2))}%`) ? label : `${label} · ${pct(percent)}`;

/** The window in force at `at`, or null. The first match in list order wins; windows never stack. */
export function activeWindow(
  config: PricingConfig,
  at: number,
): { window: RateWindow | null; ok: boolean } {
  const { day, minutes, ok } = localClock(at, config.timezone);
  return { window: config.windows.find((w) => windowCovers(w, day, minutes)) ?? null, ok };
}

export const promotionRunning = (p: Promotion, at: number): boolean =>
  (p.from == null || at >= p.from) && (p.until == null || at < p.until);

export const promotionExpired = (p: Promotion, at: number): boolean =>
  p.until != null && at >= p.until;

export const promotionPending = (p: Promotion, at: number): boolean =>
  p.from != null && at < p.from;

/** What one promotion would make a component, or null when it does not touch it. */
function promotionRate(p: Promotion, c: RateComponent, scheduled: number | null): number | null {
  if (!inScope(p, c)) return null;
  const explicit = p.rates?.[c];
  if (explicit != null) return Math.max(0, explicit);
  if (p.percent != null) return applyPercent(scheduled, p.percent);
  return null;
}

/** One component's rate at one instant, and the promotion that got it there. */
interface Resolved {
  effective: EffectiveComponent;
  /** the promotion that won this component, if any */
  winner: Promotion | null;
  /** promotions that were in scope and could have applied but lost */
  considered: Promotion[];
}

/** Base → scheduled → promoted, for one component. The whole precedence rule lives here. */
function resolveComponent(
  c: RateComponent,
  base: RateSet,
  window: RateWindow | null,
  running: Promotion[],
  unit?: TtsBillingUnit,
): Resolved {
  const from = base[c];
  const why: string[] = [];
  // An explicit rate is quoted in the unit the component is billed in — `/ 1M tokens` for the token
  // components, but whatever the endpoint bills by for speech. A per-audio-minute endpoint reading
  // "$12.00 / 1M" is simply wrong, so the unit travels with the reason.
  const quoted = (n: number | null): string => rateWithUnit(n, c, unit);
  let scheduled = from;
  if (window && from != null) {
    const explicit = window.rates?.[c];
    if (explicit != null) {
      scheduled = Math.max(0, explicit);
      why.push(`${window.label}: ${quoted(scheduled)}`);
    } else if (window.percent != null) {
      scheduled = applyPercent(from, window.percent);
      why.push(reason(window.label, window.percent));
    }
  }
  const scheduledMoved = scheduled !== from;

  // one promotion per component: the cheapest wins, then the one ending soonest, then list order
  const considered: Promotion[] = [];
  let winner: Promotion | null = null;
  let winning: number | null = null;
  for (const p of running) {
    const candidate = promotionRate(p, c, scheduled);
    if (candidate == null) continue;
    considered.push(p);
    if (
      winning == null ||
      candidate < winning - EPSILON ||
      (Math.abs(candidate - winning) <= EPSILON && endsSooner(p, winner))
    ) {
      winner = p;
      winning = candidate;
    }
  }
  // a promotion that would make a component dearer than the schedule already made it is not applied
  if (winner && winning != null && scheduled != null && winning > scheduled + EPSILON) {
    winner = null;
    winning = null;
  }
  let rate = scheduled;
  if (winner && winning != null) {
    rate = winning;
    why.push(
      winner.percent != null && winner.rates?.[c] == null
        ? reason(winner.label, winner.percent)
        : `${winner.label}: ${quoted(winning)}`,
    );
  }
  return {
    effective: {
      component: c,
      rate,
      base: from,
      scheduled,
      window: window && scheduledMoved ? window.label : null,
      promotion: winner?.label ?? null,
      why,
    },
    winner,
    considered,
  };
}

const EPSILON = 1e-12;

function endsSooner(p: Promotion, against: Promotion | null): boolean {
  if (!against) return true;
  return (p.until ?? Infinity) < (against.until ?? Infinity);
}

/** Every component resolved at one instant, without the `next` lookahead. */
function resolveAll(
  base: RateSet,
  config: PricingConfig,
  at: number,
  unit?: TtsBillingUnit,
): {
  components: Record<RateComponent, EffectiveComponent>;
  window: RateWindow | null;
  ok: boolean;
  applied: Promotion[];
  shadowed: Promotion[];
} {
  const { window, ok } = activeWindow(config, at);
  const running = config.promotions.filter((p) => promotionRunning(p, at));
  const components = {} as Record<RateComponent, EffectiveComponent>;
  const appliedIds = new Set<string>();
  const consideredIds = new Set<string>();
  for (const c of RATE_COMPONENTS) {
    const r = resolveComponent(c, base, window, running, unit);
    components[c] = r.effective;
    if (r.winner) appliedIds.add(r.winner.id);
    for (const p of r.considered) consideredIds.add(p.id);
  }
  return {
    components,
    window,
    ok,
    applied: config.promotions.filter((p) => appliedIds.has(p.id)),
    shadowed: config.promotions.filter((p) => consideredIds.has(p.id) && !appliedIds.has(p.id)),
  };
}

/**
 * Every rate in force at one instant, with the reasoning and the next change.
 *
 * `base` is the endpoint's own card; `config` is the schedule and the promotions. A component whose
 * base rate is `null` stays null throughout — a promotion cannot invent a cached-input rate for an
 * endpoint that does not have one.
 *
 * `unit` is the unit a **speech** rate is written in. It changes nothing about the arithmetic; it is
 * how the reasons come out quoting `$12.00 / audio min` rather than `$12.00 / 1M` on an endpoint
 * that does not bill per million of anything. A token card leaves it out.
 */
export function effectiveRates(
  base: RateSet,
  config: PricingConfig,
  at: number,
  unit?: TtsBillingUnit,
): PricingSnapshot {
  const { components, window, ok, applied, shadowed } = resolveAll(base, config, at, unit);
  return {
    at,
    timezone: config.timezone,
    timezoneOk: ok,
    components,
    window,
    applied,
    shadowed,
    next: nextChange(base, config, at, unit),
  };
}

/** A stable string for "have the rates changed", used to find the next boundary. */
const signature = (s: Record<RateComponent, EffectiveComponent>): string =>
  RATE_COMPONENTS.map((c) => `${c}:${s[c].rate ?? "-"}:${s[c].why.join("|")}`).join(";");

const HORIZON_DAYS = 14;

/**
 * When the effective rates change next, and what changes.
 *
 * The candidates are exact: every window edge in the next fortnight, plus every promotion start and
 * end. Local minutes are advanced arithmetically from `at`, which is exact except across a daylight
 * saving change — see the limitations note in the README.
 */
export function nextChange(
  base: RateSet,
  config: PricingConfig,
  at: number,
  unit?: TtsBillingUnit,
): PricingChange | null {
  const now = localClock(at, config.timezone);
  const candidates: PricingChange[] = [];
  const MINUTE = 60_000;

  for (let d = 0; d <= HORIZON_DAYS; d++)
    for (const w of config.windows)
      for (const [edge, label] of [
        [w.from, `${w.label} starts`],
        [w.to, `${w.label} ends`],
      ] as const) {
        const delta = d * 1440 + ((edge - now.minutes + 1440) % 1440);
        if (delta > 0) candidates.push({ at: at + delta * MINUTE, label });
      }

  for (const p of config.promotions) {
    if (p.from != null && p.from > at) candidates.push({ at: p.from, label: `${p.label} starts` });
    if (p.until != null && p.until > at) candidates.push({ at: p.until, label: `${p.label} ends` });
  }

  const current = signature(resolveAll(base, config, at, unit).components);
  candidates.sort((a, b) => a.at - b.at);
  for (const candidate of candidates)
    // one millisecond in, so a boundary is read on the side it opens
    if (signature(resolveAll(base, config, candidate.at + 1, unit).components) !== current)
      return candidate;
  return null;
}

// ---------- normalizing what a provider reported ----------

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

const PROBLEM: Record<string, string> = {
  "cache-not-reported":
    "This provider did not report cached input, so how much of the input was cached is unknown.",
  "input-missing": "No input token count came back, so the input charge could not be worked out.",
  "output-missing": "No output token count came back.",
  "cache-exceeds-input":
    "The reported cached and cache-write tokens add up to more than the total input. The counts were clamped so no token is charged twice, and this cost should be treated as unreliable.",
  negative: "A token count came back negative. It was read as zero.",
  "usage-not-reported":
    "This provider returned no usage for the request, so the charge is worked out from what was counted on the way out rather than from anything it confirmed.",
  "billed-unit-missing":
    "The provider reported usage, but not the quantity this endpoint bills on. That quantity is the one counted here, so the charge is an estimate rather than a reconciliation.",
  "audio-tokens-estimated":
    "The provider did not report audio tokens. They were worked out from the audio's length and this endpoint's tokens-per-second setting, which is an assumption and not a measurement.",
};

export const USAGE_FORMATS: { value: UsageFormat; label: string; hint: string }[] = [
  {
    value: "openai",
    label: "OpenAI-shaped",
    hint: "prompt_tokens includes prompt_tokens_details.cached_tokens",
  },
  {
    value: "anthropic",
    label: "Anthropic-shaped",
    hint: "input_tokens excludes cache_read_input_tokens and cache_creation_input_tokens",
  },
  {
    value: "plain",
    label: "Totals only",
    hint: "prompt_tokens and completion_tokens, no cache detail",
  },
  { value: "internal", label: "Already normalized", hint: "the shape this app works in" },
];

/**
 * Read a provider's usage payload into the one internal shape.
 *
 * The two shapes that matter disagree about the most important thing: OpenAI's `prompt_tokens`
 * *includes* the cached tokens, Anthropic's `input_tokens` *excludes* them. Getting that backwards
 * either charges cached tokens twice or loses them, so it is the first thing this does — and
 * `inputTokens` on the way out always means the total.
 */
export function normalizeUsage(raw: Record<string, unknown>, format: UsageFormat): TokenUsage {
  const problems: UsageProblem[] = [];
  const note = (code: UsageProblem["code"], repaired?: boolean) =>
    problems.push({ code, message: PROBLEM[code], ...(repaired ? { repaired: true } : {}) });

  let inputTotal: number | null = null;
  let cachedInput: number | null = null;
  let cacheWrite: number | null = null;
  let output: number | null = null;

  if (format === "openai") {
    const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
    inputTotal = num(raw.prompt_tokens);
    cachedInput = details ? num(details.cached_tokens) : null;
    cacheWrite = null;
    output = num(raw.completion_tokens);
  } else if (format === "anthropic") {
    const uncached = num(raw.input_tokens);
    cachedInput = num(raw.cache_read_input_tokens);
    cacheWrite = num(raw.cache_creation_input_tokens);
    // input_tokens counts only what was *not* served from or written to the cache
    inputTotal =
      uncached == null
        ? null
        : uncached + Math.max(0, cachedInput ?? 0) + Math.max(0, cacheWrite ?? 0);
    output = num(raw.output_tokens);
  } else if (format === "plain") {
    inputTotal = num(raw.prompt_tokens) ?? num(raw.input_tokens);
    output = num(raw.completion_tokens) ?? num(raw.output_tokens);
  } else {
    inputTotal = num(raw.inputTokens);
    cachedInput = num(raw.cachedInput);
    cacheWrite = num(raw.cacheWrite);
    output = num(raw.outputTokens);
  }

  if (inputTotal == null) {
    note("input-missing");
    inputTotal = 0;
  }
  if (output == null) {
    note("output-missing");
    output = 0;
  }
  if (
    inputTotal < 0 ||
    output < 0 ||
    (cachedInput != null && cachedInput < 0) ||
    (cacheWrite != null && cacheWrite < 0)
  ) {
    note("negative", true);
    inputTotal = Math.max(0, inputTotal);
    output = Math.max(0, output);
    if (cachedInput != null) cachedInput = Math.max(0, cachedInput);
    if (cacheWrite != null) cacheWrite = Math.max(0, cacheWrite);
  }
  const parts = (cachedInput ?? 0) + (cacheWrite ?? 0);
  if (parts > inputTotal) {
    note("cache-exceeds-input", true);
    // keep the reported parts visible but never let the ordinary-input line go negative
    inputTotal = parts;
  }
  if (cachedInput == null) note("cache-not-reported");

  const reportedCost = num(raw.cost) ?? num(raw.total_cost) ?? null;
  return {
    inputTokens: inputTotal,
    cachedInput,
    cacheWrite,
    outputTokens: output,
    format,
    problems,
    ...(reportedCost != null ? { reportedCost } : {}),
  };
}

// ---------- normalizing what a speech provider reported ----------

export const SPEECH_USAGE_FORMATS: { value: SpeechUsageFormat; label: string; hint: string }[] = [
  {
    value: "gemini",
    label: "Gemini-shaped",
    hint: "usageMetadata.promptTokenCount, with the audio tokens in candidatesTokensDetails",
  },
  { value: "fish", label: "Fish-shaped", hint: "usage.bytes — the quantity it actually bills on" },
  { value: "plain", label: "Totals only", hint: "characters and audio seconds, no token detail" },
  { value: "internal", label: "Already normalized", hint: "the shape this app works in" },
  { value: "none", label: "Reports nothing", hint: "OpenAI's speech endpoint returns no usage" },
];

const nothingReported = (format: SpeechUsageFormat): SpeechUsage => ({
  chars: null,
  bytes: null,
  textTokens: null,
  audioSeconds: null,
  audioTokens: null,
  format,
  problems: [{ code: "usage-not-reported", message: PROBLEM["usage-not-reported"] }],
});

/**
 * Read a speech provider's usage payload into the one internal shape.
 *
 * The same rule as the token side and for the same reason: nothing downstream reads a provider
 * payload directly, so "the provider did not say" can never be quietly rounded to zero on its way
 * through. Each shape reports a *different* quantity — Gemini counts tokens both ways, Fish counts
 * the bytes it bills on, OpenAI's speech endpoint counts nothing at all — and the fields it did not
 * fill in stay `null`.
 */
export function normalizeSpeechUsage(
  raw: Record<string, unknown> | null | undefined,
  format: SpeechUsageFormat,
): SpeechUsage {
  if (format === "none" || !raw) return nothingReported(format);
  const problems: UsageProblem[] = [];
  let chars: number | null = null;
  let bytes: number | null = null;
  let textTokens: number | null = null;
  let audioSeconds: number | null = null;
  let audioTokens: number | null = null;

  if (format === "gemini") {
    const meta = (raw.usageMetadata ?? raw) as Record<string, unknown>;
    textTokens = num(meta.promptTokenCount);
    // The audio tokens are the AUDIO-modality slice of the response, not the whole of it: a
    // response that also carries text would otherwise have its text charged at the audio rate.
    const details = Array.isArray(meta.candidatesTokensDetails)
      ? (meta.candidatesTokensDetails as Record<string, unknown>[])
      : [];
    const audio = details.find((d) => String(d.modality).toUpperCase() === "AUDIO");
    audioTokens = audio ? num(audio.tokenCount) : num(meta.candidatesTokenCount);
  } else if (format === "fish") {
    const usage = (raw.usage ?? raw) as Record<string, unknown>;
    bytes = num(usage.bytes);
    chars = num(usage.characters) ?? num(usage.chars);
  } else if (format === "plain") {
    chars = num(raw.characters) ?? num(raw.chars);
    audioSeconds = num(raw.audio_seconds) ?? num(raw.duration);
  } else {
    chars = num(raw.chars);
    bytes = num(raw.bytes);
    textTokens = num(raw.textTokens);
    audioSeconds = num(raw.audioSeconds);
    audioTokens = num(raw.audioTokens);
  }

  const clamp = (n: number | null): number | null => {
    if (n == null) return null;
    if (n < 0) {
      if (!problems.some((p) => p.code === "negative"))
        problems.push({ code: "negative", message: PROBLEM.negative, repaired: true });
      return 0;
    }
    return n;
  };
  chars = clamp(chars);
  bytes = clamp(bytes);
  textTokens = clamp(textTokens);
  audioSeconds = clamp(audioSeconds);
  audioTokens = clamp(audioTokens);

  if (chars == null && bytes == null && textTokens == null && audioTokens == null)
    problems.push({ code: "usage-not-reported", message: PROBLEM["usage-not-reported"] });

  const reportedCost = num(raw.cost) ?? num(raw.total_cost) ?? null;
  return {
    chars,
    bytes,
    textTokens,
    audioSeconds,
    audioTokens,
    format,
    problems,
    ...(reportedCost != null ? { reportedCost } : {}),
  };
}

/** What the provider said about the quantity this component is charged on, or `null`. */
function reportedQuantity(
  component: RateComponent,
  unit: TtsBillingUnit,
  reported: SpeechUsage | null,
): number | null {
  if (!reported) return null;
  if (component === "textTokens") return reported.textTokens;
  if (component === "audioTokens") return reported.audioTokens;
  switch (unit) {
    case "chars":
      return reported.chars;
    case "bytes":
      return reported.bytes;
    case "minute":
      return reported.audioSeconds == null ? null : reported.audioSeconds / 60;
    default:
      // nobody reports "how many requests this was" — we are the ones who split it
      return null;
  }
}

/** Input tokens charged at the ordinary rate: the total less the parts that have their own line. */
export const uncachedInput = (u: TokenUsage): number =>
  Math.max(0, u.inputTokens - (u.cachedInput ?? 0) - (u.cacheWrite ?? 0));

export const usageTrustworthy = (u: TokenUsage): boolean =>
  !u.problems.some((p) => p.code !== "cache-not-reported");

// ---------- pricing one request ----------

/**
 * Which instant a request is priced at.
 *
 * One rule, stated in one place, and recorded on every receipt: a request is priced at the moment
 * it **completed**. A provider that bills at dispatch, or at the start of the batch, would change
 * this function and nothing else — which is why the rule travels with the receipt rather than being
 * implied by whoever happened to call it.
 */
export const PRICING_RULE = "priced at the rates in force when the request completed";

export interface PriceOptions {
  /** the instant to read rates at; the caller decides, and says so with `rule` */
  at: number;
  rule?: string;
  /** trust a charge the provider reported over our own arithmetic */
  preferReported?: boolean;
}

/** Usage × the rates in force at one instant. The result is a receipt: keep it, never redo it. */
export function priceRequest(
  base: RateSet,
  config: PricingConfig,
  usage: TokenUsage,
  opts: PriceOptions,
): PricedRequest {
  const snapshot = effectiveRates(base, config, opts.at);
  const r = snapshot.components;
  const unknowns: string[] = [];
  const lines: CostLine[] = [];

  const push = (
    component: RateComponent,
    tokens: number,
    rateUsed: number | null,
    note?: string,
  ) => {
    lines.push({
      component,
      tokens,
      rate: rateUsed,
      amount: rateUsed == null ? null : (tokens / 1e6) * rateUsed,
      ...(note ? { note } : {}),
    });
  };

  const cached = usage.cachedInput;
  const written = usage.cacheWrite ?? 0;
  const ordinary = uncachedInput(usage);

  if (cached == null) {
    // Never present an assumed cache miss as a fact. The whole input is charged at the ordinary
    // rate because that is the usual reading, and the figure is labelled an estimate.
    push(
      "input",
      usage.inputTokens - written,
      r.input.rate,
      "the provider did not report cached tokens, so all of it is charged at the ordinary rate",
    );
    // …and that is only an *upper* bound where the ordinary rate is the dearest an input token can
    // be charged at. An endpoint whose cached rate is higher than its input rate could have cost
    // more than this, so the sentence says which way the uncertainty runs rather than claiming the
    // reassuring direction on every card.
    const cachedDearer =
      r.cachedInput.rate != null && r.input.rate != null && r.cachedInput.rate > r.input.rate;
    unknowns.push(
      cachedDearer
        ? "How much of the input was cached was not reported. The whole input is charged at the ordinary rate, but this endpoint's cached rate is higher than its ordinary one, so the real cost could be more than this figure."
        : "How much of the input was cached was not reported. The whole input is charged at the ordinary rate, so the real cost is this figure or less.",
    );
  } else {
    push("input", ordinary, r.input.rate, "input the provider read in full");
    if (cached > 0 || r.cachedInput.rate != null)
      push(
        "cachedInput",
        cached,
        r.cachedInput.rate ?? r.input.rate,
        r.cachedInput.rate == null
          ? "no separate cached rate is set for this endpoint, so these are charged as ordinary input"
          : undefined,
      );
  }
  if (written > 0)
    push(
      "cacheWrite",
      written,
      r.cacheWrite.rate ?? r.input.rate,
      r.cacheWrite.rate == null
        ? "no separate cache-write rate is set, so these are charged as ordinary input"
        : undefined,
    );
  push("output", usage.outputTokens, r.output.rate);

  const missingRate = lines.some((l) => l.rate == null);
  const calculated = missingRate ? null : lines.reduce((sum, l) => sum + (l.amount ?? 0), 0);

  for (const p of usage.problems) if (p.code !== "cache-not-reported") unknowns.push(p.message);

  const reported = usage.reportedCost ?? null;
  let basis: CostBasis;
  let total: number | null;
  if (opts.preferReported && reported != null) {
    basis = "provider-reported";
    total = reported;
  } else if (calculated == null) {
    basis = "unknown";
    total = null;
    unknowns.push("No rate is set for one of the components this request used.");
  } else if (cached == null || !usageTrustworthy(usage)) {
    basis = "estimated";
    total = calculated;
  } else {
    basis = "calculated";
    total = calculated;
  }

  return {
    at: opts.at,
    rule: opts.rule ?? PRICING_RULE,
    lines,
    total,
    calculated,
    reported,
    basis,
    unknowns,
    usage,
    rates: r,
  };
}

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  calculated: "calculated here",
  "provider-reported": "reported by the provider",
  estimated: "estimated",
  unknown: "unknown",
};

export const COST_BASIS_DETAIL: Record<CostBasis, string> = {
  calculated:
    "worked out here from the reported usage and the rates in force when the request completed",
  "provider-reported": "the charge the provider itself reported for this request",
  estimated:
    "worked out from the rates, but part of the usage was missing or inconsistent — treat it as an upper bound",
  unknown: "no rate is set for this endpoint, so nothing can be worked out",
};

// ---------- pricing one speech request ----------

export interface SpeechPriceOptions extends PriceOptions {
  /** what the provider reported for this request, when it reported anything */
  reported?: SpeechUsage | null;
}

/**
 * What one rendered clip cost, at the rates in force when it landed.
 *
 * The same rule as the LLM side and for the same reason: a bulk run over a book takes minutes, and
 * an off-peak window closing or a promotion expiring part-way through has to charge the clips
 * either side of it differently.
 *
 * Three things are kept apart in the answer, because they are three different claims:
 *
 *   provider-reported  the provider told us what it charged, and that is the figure
 *   calculated         every quantity charged was either reported by the provider or is exactly
 *                      known here — the characters we submitted, the requests we split it into
 *   estimated          a charged quantity had to be worked out rather than counted: audio tokens
 *                      from a duration, text tokens from a character count
 *
 * `audioSeconds` is `0` for a clip that failed — a per-minute or audio-token endpoint therefore
 * charges it nothing, while a per-character, per-byte or per-request one still charges for what was
 * sent, which is what those providers actually do.
 */
export function priceSpeechRequest(
  billing: TtsBilling,
  config: PricingConfig,
  measured: BillableUnits,
  opts: SpeechPriceOptions,
): SpeechCharge {
  const components = resolveAll(speechRates(billing), config, opts.at, billing.unit).components;
  const reported = opts.reported ?? null;
  const unknowns: string[] = [];
  const lines: SpeechChargeLine[] = [];
  // an audio quantity is a measurement of what came back; everything else is a count of what we
  // sent, which we know exactly
  const estimatedHere = (c: RateComponent): boolean => c === "audioTokens" || c === "textTokens";

  for (const c of speechComponents(billing.unit)) {
    const effective = components[c];
    const fromProvider = reportedQuantity(c, billing.unit, reported);
    const quantity = fromProvider ?? quantityFor(c, billing.unit, measured);
    const source: QuantitySource =
      fromProvider != null ? "reported" : estimatedHere(c) ? "estimated" : "measured";
    lines.push({
      component: c,
      quantity,
      source,
      rate: effective.rate,
      base: effective.base,
      why: effective.why,
      amount: componentAmount(c, billing.unit, quantity, effective.rate),
      ...(source === "estimated"
        ? {
            note:
              c === "audioTokens"
                ? `worked out from ${measured.audioSeconds.toFixed(2)}s of audio at ${audioTokensPerSecondOf(billing)} tokens a second — this endpoint's setting, not a reported count`
                : "worked out from the submitted text; the provider did not report a token count",
          }
        : fromProvider != null
          ? { note: "the quantity the provider reported for this request" }
          : undefined),
    });
  }

  for (const p of reported?.problems ?? [])
    if (p.code !== "usage-not-reported") unknowns.push(p.message);

  const missingRate = lines.some((l) => l.rate == null);
  const calculated = missingRate ? null : lines.reduce((sum, l) => sum + (l.amount ?? 0), 0);
  const providerCharge = reported?.reportedCost ?? null;

  let basis: CostBasis;
  let amount: number | null;
  if (opts.preferReported && providerCharge != null) {
    basis = "provider-reported";
    amount = providerCharge;
  } else if (calculated == null) {
    basis = "unknown";
    amount = null;
    unknowns.push(
      billsAudioTokens(billing.unit) && billing.rate != null
        ? "This endpoint bills for the text and the audio separately and only one of the two rates is set. The request is counted and never priced, so every total that leaves it out is a floor, not the bill."
        : "No rate is set for this endpoint, so this request is counted but never priced. Every total that leaves it out is a floor, not the bill.",
    );
  } else {
    amount = calculated;
    basis = lines.some((l) => l.source === "estimated") ? "estimated" : "calculated";
  }

  if (basis === "estimated" && billsAudioTokens(billing.unit))
    unknowns.push(PROBLEM["audio-tokens-estimated"]);
  else if (reported && reported.problems.some((p) => p.code === "usage-not-reported"))
    unknowns.push(PROBLEM["usage-not-reported"]);
  else if (reported && lines.some((l) => l.source !== "reported") && basis !== "unknown")
    unknowns.push(PROBLEM["billed-unit-missing"]);

  return {
    at: opts.at,
    rule: opts.rule ?? PRICING_RULE,
    unit: billing.unit,
    ...(billsAudioTokens(billing.unit)
      ? { audioTokensPerSecond: audioTokensPerSecondOf(billing) }
      : {}),
    units: measured,
    reported,
    lines,
    amount,
    basis,
    unknowns: [...new Set(unknowns)],
  };
}

/** Every step that moved any of this charge's rates off the card, in order. */
export const speechWhy = (charge: SpeechCharge): string[] => [
  ...new Set(charge.lines.flatMap((l) => l.why)),
];

// ---------- one display shape for both kinds ----------

const count = (n: number, unit: string): string =>
  `${Math.round(n).toLocaleString()} ${unit}${Math.round(n) === 1 ? "" : "s"}`;

/** What a token line charged for, in the unit that line is measured in. */
const tokenQuantity = (l: CostLine): string => count(l.tokens, "token");

/** What one speech line was charged on, in that component's own unit. */
function speechQuantity(charge: SpeechCharge, line: SpeechChargeLine): string {
  if (line.component === "textTokens") return count(line.quantity, "text token");
  if (line.component === "audioTokens") return count(line.quantity, "audio token");
  switch (charge.unit) {
    case "chars":
      return count(line.quantity, "character");
    case "bytes":
      return `${Math.round(line.quantity).toLocaleString()} UTF-8 bytes`;
    case "minute":
      return `${line.quantity.toFixed(2)} audio minutes`;
    case "request":
      return count(line.quantity, "request");
    default:
      return count(line.quantity, "unit");
  }
}

/** A priced LLM request as lines a table can render. */
export const tokenChargeLines = (priced: PricedRequest): ChargeLine[] =>
  priced.lines
    .filter((l) => l.tokens > 0 || l.component === "input" || l.component === "output")
    .map((l) => ({
      label: COMPONENT_LABEL[l.component],
      quantity: tokenQuantity(l),
      rate: rateWithUnit(l.rate, l.component),
      amount: l.amount,
      why: priced.rates[l.component]?.why ?? [],
      ...(l.note ? { note: l.note } : {}),
    }));

/** A charged clip as the same lines — one for a per-character endpoint, two for a token-billed one. */
export const speechChargeLines = (charge: SpeechCharge): ChargeLine[] =>
  charge.lines.map((l) => ({
    label: chargeLabel(l.component, charge.unit),
    quantity: speechQuantity(charge, l),
    rate: rateWithUnit(l.rate, l.component, charge.unit),
    amount: l.amount,
    why: l.why,
    ...(l.note ||
    (charge.units.requests > 1 && charge.unit !== "request" && l.component !== "audioTokens")
      ? {
          note: [
            l.note,
            charge.units.requests > 1 && charge.unit !== "request" && l.component !== "audioTokens"
              ? `sent as ${charge.units.requests} requests — the line was over this endpoint's limit`
              : "",
          ]
            .filter(Boolean)
            .join("; "),
        }
      : {}),
  }));

/**
 * How the measured quantities divide, as a sentence that cannot be read as double counting.
 *
 * Every quantity is named, including the ones this endpoint does not bill on, and the last clause
 * says which single one was charged — so a reader can see that 1,240 characters and 1,860 bytes are
 * two readings of the same text rather than two things being paid for.
 */
export function speechSentence(charge: SpeechCharge): string {
  const u = charge.units;
  const parts = [
    `${u.chars.toLocaleString()} characters (${u.bytes.toLocaleString()} UTF-8 bytes` +
      `${u.textTokens != null ? `, ~${u.textTokens.toLocaleString()} text tokens` : ""}) submitted`,
  ];
  if (u.instructionChars)
    parts.push(`${u.instructionChars.toLocaleString()} of them voice instructions`);
  if (u.audioSeconds > 0)
    parts.push(
      `${(u.audioSeconds / 60).toFixed(2)} audio minutes returned` +
        (u.audioTokens != null ? ` (~${u.audioTokens.toLocaleString()} audio tokens)` : ""),
    );
  else parts.push("nothing came back, so no audio was produced");
  if (u.requests > 1) parts.push(`across ${u.requests} requests`);
  return `${parts.join(", ")}. This endpoint bills ${billingUnitLabel(charge.unit)}, so ${BILLING_PHRASE[charge.unit]}.`;
}

// ---------- estimating before a run ----------

/**
 * What a run would cost before anything is sent.
 *
 * Cache usage cannot be known in advance, so the headline figure assumes **none**: every input
 * token at the ordinary rate. A figure based on recently observed cache use is offered beside it,
 * clearly separate, and never used for a budget check. `withoutPromotions` is the figure a budget
 * has to survive, because a promotion can expire between the first request and the last.
 */
export function estimateRates(
  base: RateSet,
  config: PricingConfig,
  tokens: { inputTokens: number; outputTokens: number },
  at: number,
  observed?: { hitRate: number; samples: number } | null,
): RateEstimate {
  const snapshot = effectiveRates(base, config, at);
  const inRate = snapshot.components.input.rate ?? 0;
  const outRate = snapshot.components.output.rate ?? 0;
  const inputCost = (tokens.inputTokens / 1e6) * inRate;
  const outputCost = (tokens.outputTokens / 1e6) * outRate;
  const cost = inputCost + outputCost;

  const cachedRate = snapshot.components.cachedInput.rate;
  const withObservedCache =
    observed && observed.samples > 0 && cachedRate != null && observed.hitRate > 0
      ? {
          hitRate: observed.hitRate,
          samples: observed.samples,
          cost:
            (tokens.inputTokens * (1 - observed.hitRate) * inRate) / 1e6 +
            (tokens.inputTokens * observed.hitRate * cachedRate) / 1e6 +
            outputCost,
        }
      : null;

  // The same work with every discount gone **and** every input token at the dearest rate any input
  // token could be charged at: what the budget must be able to cover. Cached and cache-write tokens
  // are slices of the input, and a cache write usually costs more than ordinary input, so reserving
  // the whole input at the ordinary rate would leave a request able to exceed its own reservation.
  const bare = effectiveRates(base, { ...config, windows: [], promotions: [] }, at);
  const bareInput =
    dearestInput({
      input: bare.components.input.rate,
      cachedInput: bare.components.cachedInput.rate,
      cacheWrite: bare.components.cacheWrite.rate,
    }) ?? 0;
  const withoutPromotions =
    (tokens.inputTokens / 1e6) * bareInput +
    (tokens.outputTokens / 1e6) * (bare.components.output.rate ?? 0);

  const cautions: string[] = [];
  // "no cache savings" is only the conservative reading where the cached and cache-write rates are
  // cheaper than ordinary input. Where one of them is dearer — a cache write normally is — this
  // figure is a middle case, not a ceiling, and the caution says so and names the ceiling.
  const dearer = dearestInput({
    input: snapshot.components.input.rate,
    cachedInput: cachedRate,
    cacheWrite: snapshot.components.cacheWrite.rate,
  });
  const inputIsCeiling = dearer == null || dearer <= inRate + EPSILON;
  if (cachedRate != null || snapshot.components.cacheWrite.rate != null)
    cautions.push(
      inputIsCeiling
        ? "Cache usage is only known after a request comes back, so this figure assumes none of the input is cached. The real cost is this or less."
        : `Cache usage is only known after a request comes back, so this figure charges the whole input at the ordinary rate. This endpoint charges more than that for ${snapshot.components.cacheWrite.rate != null && snapshot.components.cacheWrite.rate > inRate ? "cache writes" : "cached input"}, so the real cost can be higher — ${money(withoutPromotions)} is the ceiling, and that is what a budget is checked against.`,
    );
  if (snapshot.next)
    cautions.push(
      `Rates change at ${stamp(snapshot.next.at, config.timezone)} — ${snapshot.next.label.toLowerCase()}. A run still going then straddles it.`,
    );
  if (snapshot.applied.length)
    cautions.push(
      `${snapshot.applied.length === 1 ? "A promotion is" : `${snapshot.applied.length} promotions are`} in force. Budget checks use ${money(withoutPromotions)}, the price without ${snapshot.applied.length === 1 ? "it" : "them"}, so a promotion ending mid-run cannot overshoot a cap.`,
    );
  else if (!inputIsCeiling)
    cautions.push(
      `Budget checks use ${money(withoutPromotions)}, every input token at the dearest rate this endpoint charges for one, so no request can cost more than it reserved.`,
    );

  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    inputCost,
    outputCost,
    cost,
    withObservedCache,
    withoutPromotions,
    cautions,
  };
}

/**
 * What a narration run would cost before anything is sent.
 *
 * On a per-character, per-byte or per-request endpoint there is nothing unknowable here: the
 * request's cost follows from the text, so the estimate *is* the figure. The two models that bill
 * on the audio are different, and the difference is stated rather than smoothed over:
 *
 *   minute        rests on this app's own estimate of how long each line takes to read
 *   audio-tokens  rests on that **and** on the endpoint's tokens-per-second setting — an
 *                 assumption about the provider's audio tokeniser, not a measurement of anything
 *
 * The two halves come back separately (`inputCost` + `audioCost` = `cost`) because on a token-billed
 * endpoint they are worked out from different things and a single total hides which one is large.
 * `withoutPromotions` is again what a budget is checked against, because a run over a book takes
 * long enough for a discount to end inside it.
 */
export function estimateSpeech(
  billing: TtsBilling,
  config: PricingConfig,
  units: BillableUnits,
  at: number,
): SpeechEstimate {
  const components = speechComponents(billing.unit);
  const audioSide = (c: RateComponent) => c === "audioTokens" || billing.unit === "minute";

  const priceWith = (snapshotComponents: Record<RateComponent, EffectiveComponent>) => {
    let input: number | null = null;
    let audio: number | null = null;
    let known = true;
    for (const c of components) {
      const amount = componentAmount(
        c,
        billing.unit,
        quantityFor(c, billing.unit, units),
        snapshotComponents[c].rate,
      );
      if (amount == null) {
        known = false;
        continue;
      }
      if (audioSide(c)) audio = (audio ?? 0) + amount;
      else input = (input ?? 0) + amount;
    }
    return { input, audio, total: known ? (input ?? 0) + (audio ?? 0) : null };
  };

  const snapshot = effectiveRates(speechRates(billing), config, at, billing.unit);
  const now = priceWith(snapshot.components);
  const bare = priceWith(
    resolveAll(speechRates(billing), { ...config, windows: [], promotions: [] }, at, billing.unit)
      .components,
  );

  const cautions: string[] = [];
  if (snapshot.next)
    cautions.push(
      `Rates change at ${stamp(snapshot.next.at, config.timezone)} — ${snapshot.next.label.toLowerCase()}. A run still going then straddles it.`,
    );
  if (snapshot.applied.length && now.total != null && bare.total != null)
    cautions.push(
      `${snapshot.applied.length === 1 ? "A promotion is" : `${snapshot.applied.length} promotions are`} in force. Budget checks use ${money(bare.total)}, the price without ${snapshot.applied.length === 1 ? "it" : "them"}, so a promotion ending mid-run cannot overshoot a cap.`,
    );
  if (billing.unit === "minute")
    cautions.push(
      "This endpoint bills on the audio it returns, so the figure rests on this app's estimate of how long each line will take to read.",
    );
  if (billsAudioTokens(billing.unit))
    cautions.push(
      `The audio half is ${Math.round(units.audioSeconds).toLocaleString()}s of expected audio at ${audioTokensPerSecondOf(billing)} audio tokens a second — this endpoint's configured assumption about its provider's audio tokeniser. Audio tokens do not follow from the text, so this half is the part of the estimate most likely to move; the input half is counted from the text that will actually be submitted.`,
    );

  return {
    inputCost: now.input,
    audioCost: now.audio,
    cost: now.total,
    withoutPromotions: bare.total,
    units,
    cautions,
  };
}

// ---------- saying it in one line ----------

/**
 * The compact line the Pricing tab leads with, per component:
 * "Input: $0.50 / 1M tokens · 50% promotion applied · ends tomorrow".
 */
export function componentLine(
  snapshot: PricingSnapshot,
  c: RateComponent,
  now: number,
  unit?: TtsBillingUnit,
): string {
  const e = snapshot.components[c];
  if (e.rate == null)
    return `${COMPONENT_LABEL[c]}: ${
      c === "speech" || c === "textTokens" || c === "audioTokens"
        ? "rate not known"
        : "charged as ordinary input"
    }`;
  const parts = [`${COMPONENT_LABEL[c]}: ${rateWithUnit(e.rate, c, unit)}`];
  for (const why of e.why) parts.push(why);
  if (e.promotion) {
    const p = snapshot.applied.find((x) => x.label === e.promotion);
    if (p?.until != null) parts.push(`ends ${whenPhrase(p.until, now, snapshot.timezone)}`);
  } else if (snapshot.next && e.why.length) {
    parts.push(
      `${snapshot.next.label.toLowerCase()} ${whenPhrase(snapshot.next.at, now, snapshot.timezone)}`,
    );
  }
  return parts.join(" · ");
}

/** The one-line pricing a card shows, with whatever is moving it right now. */
export function pricingOneLiner(snapshot: PricingSnapshot, unit?: TtsBillingUnit): string {
  const i = snapshot.components.input;
  const o = snapshot.components.output;
  const head =
    unit !== undefined
      ? speechOneLiner(snapshot, unit)
      : `${money(i.rate ?? 0)} in / ${money(o.rate ?? 0)} out · 1M tokens`;
  const notes: string[] = [];
  if (snapshot.window) notes.push(snapshot.window.label);
  for (const p of snapshot.applied) notes.push(p.label);
  return notes.length ? `${head} · ${notes.join(", ")}` : head;
}

/**
 * The rate half of a speech endpoint's one-liner, in whichever model it bills under.
 *
 * A two-rate endpoint says both, because quoting only one of them is how "$1 per 1M" ends up on a
 * card whose bill is dominated by the audio side. Zero is "no charge"; not-known says so.
 */
function speechOneLiner(snapshot: PricingSnapshot, unit: TtsBillingUnit): string {
  const components = speechComponents(unit);
  if (components.every((c) => snapshot.components[c].rate === 0)) return "no charge";
  if (components.some((c) => snapshot.components[c].rate == null))
    // one half of a two-rate card is not half an answer: the endpoint cannot be priced at all
    return components.length > 1 && components.some((c) => snapshot.components[c].rate != null)
      ? `${COMPONENT_LABEL[components.find((c) => snapshot.components[c].rate == null)!].toLowerCase()} rate not known`
      : "rate not known";
  const parts = components.map((c) => {
    const rate = snapshot.components[c].rate!;
    return c === "speech"
      ? `${money(rate)} ${billingUnitLabel(unit)}`
      : `${money(rate)} ${c === "textTokens" ? "text" : "audio"}`;
  });
  return billsAudioTokens(unit) ? `${parts.join(" + ")} · 1M tokens` : parts.join(" · ");
}

// ---------- validation ----------

/** Contradictions a person can type into a rate card, in the words the form shows. These block. */
export function pricingProblems(config: PricingConfig): string[] {
  const out: string[] = [];
  if (!timezoneValid(config.timezone))
    out.push(`“${config.timezone}” is not a timezone this browser knows. Windows are read in UTC.`);
  for (const value of [config.cachedInput, config.cacheWrite])
    if (value != null && (!Number.isFinite(value) || value < 0))
      out.push("Cached and cache-write rates must be zero or greater.");
  for (const w of config.windows) {
    if (!w.label.trim()) out.push("Every schedule window needs a name.");
    for (const edge of [w.from, w.to])
      if (!Number.isInteger(edge) || edge < 0 || edge > 1439)
        out.push(`“${w.label || "Window"}” has a time outside 00:00–23:59.`);
    if (w.percent == null && !w.rates)
      out.push(`“${w.label || "Window"}” does not change any rate.`);
    if (w.percent != null && (w.percent <= -1000 || w.percent > 100))
      out.push(`“${w.label || "Window"}” must discount between 0% and 100%.`);
  }
  const ids = new Set<string>();
  for (const p of config.promotions) {
    if (!p.label.trim()) out.push("Every promotion needs a name.");
    if (ids.has(p.id)) out.push(`Two promotions share the id “${p.id}”.`);
    ids.add(p.id);
    if (p.from != null && p.until != null && p.until <= p.from)
      out.push(`“${p.label || "Promotion"}” ends before it starts.`);
    if (!p.scope.length) out.push(`“${p.label || "Promotion"}” applies to nothing — pick a scope.`);
    if (p.percent == null && !p.rates)
      out.push(`“${p.label || "Promotion"}” sets neither a discount nor a rate.`);
    if (p.percent != null && (p.percent <= 0 || p.percent > 100))
      out.push(`“${p.label || "Promotion"}” must discount between 0% and 100%.`);
  }
  return [...new Set(out)];
}

/**
 * Contradictions in a speech endpoint's billing model, in the words the form shows. These block.
 *
 * The rate itself being unknown is deliberately *not* one of them: an endpoint whose price list you
 * have not typed in yet is a legitimate state that the page reports honestly, rather than an error
 * that stops you saving.
 */
export function billingProblems(billing: TtsBilling): string[] {
  const out: string[] = [];
  const bad = (n: number | null | undefined) => n != null && (!Number.isFinite(n) || n < 0);
  if (bad(billing.rate)) out.push("The rate must be zero or greater.");
  if (billsAudioTokens(billing.unit)) {
    if (bad(billing.audioRate)) out.push("The output audio token rate must be zero or greater.");
    const tps = billing.audioTokensPerSecond;
    if (tps != null && (!Number.isFinite(tps) || tps <= 0))
      out.push("Audio tokens per second must be greater than zero.");
  }
  return out;
}

/** Things that are probably a mistake but are not contradictions, so they say so and let it be. */
export function pricingWarnings(base: RateSet, config: PricingConfig, at: number): string[] {
  const out: string[] = [];
  const input = base.input;
  if (input != null && config.cachedInput != null && config.cachedInput > input)
    out.push(
      "The cached input rate is higher than the ordinary input rate — check it is the right way round.",
    );
  if (input != null && input > 0 && config.cacheWrite != null && config.cacheWrite > input * 3)
    out.push(
      "The cache-write rate is more than three times the input rate. Check the decimal point.",
    );
  const running = config.promotions.filter((p) => promotionRunning(p, at));
  // Only the components this card actually prices. A promotion scoped to speech on an LLM endpoint
  // is not an overlap with anything — it is a scope that does nothing, which is its own warning.
  for (const c of RATE_COMPONENTS) {
    if (base[c] == null) continue;
    const overlapping = running.filter(
      (p) => inScope(p, c) && promotionRate(p, c, base[c]) != null,
    );
    if (overlapping.length > 1)
      out.push(
        `${overlapping.length} promotions cover ${COMPONENT_LABEL[c].toLowerCase()}. They do not stack — only the cheapest applies.`,
      );
  }
  // A promotion "applies to nothing" only where the card actually prices something for it to miss.
  // On a card whose rates are all unknown every component is null, and saying "check its scope"
  // there blames the scope for a missing rate — which the unknown-rate warning already explains.
  // The test is `inScope`, not list membership, so a promotion scoped to the speech rate is not
  // reported as useless on an endpoint that moved to token billing.
  const priced = RATE_COMPONENTS.filter((c) => base[c] != null);
  if (priced.length)
    for (const p of running)
      if (!p.scope.includes("model") && !priced.some((c) => inScope(p, c)))
        out.push(
          `“${p.label}” is running but applies to nothing this endpoint prices. Check its scope.`,
        );
  return [...new Set(out)];
}

// ---------- observed cache use ----------

/**
 * How much of the input recent requests actually had cached. Only requests that *reported* cache
 * detail count: a provider that says nothing must not be read as a run of cache misses.
 */
export function observedCacheRate(
  recent: TokenUsage[],
): { hitRate: number; samples: number } | null {
  const reported = recent.filter((u) => u.cachedInput != null && u.inputTokens > 0);
  if (!reported.length) return null;
  const input = reported.reduce((n, u) => n + u.inputTokens, 0);
  const cached = reported.reduce((n, u) => n + (u.cachedInput ?? 0), 0);
  return input > 0 ? { hitRate: cached / input, samples: reported.length } : null;
}
