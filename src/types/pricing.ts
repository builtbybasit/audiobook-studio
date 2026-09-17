// What an LLM endpoint charges, and what one request actually cost.
//
// Three different things are kept apart here on purpose, because conflating them is how a cost
// display starts lying:
//
//   configuration — the rate card: base rates, an optional peak/off-peak schedule, promotions
//   usage         — what the provider said came back, normalized from its own payload shape
//   a priced request — usage × the rates in force at one explicit instant, frozen forever after
//
// Nothing here is per-book or per-run. A `PricedRequest` is a receipt: once written it is never
// recalculated, so editing a rate today cannot move yesterday's spending.

/**
 * Everything an endpoint can be charged for.
 *
 * The first four are the LLM side and are always USD per 1M tokens. `speech` is the single rate a
 * text-to-speech endpoint has, and its unit is whatever that endpoint bills in — characters,
 * tokens, audio minutes or requests — which is why the unit travels beside the rate everywhere it
 * is shown. A card prices one side or the other; the components of the side it does not price are
 * `null` throughout, and no window or promotion can invent one.
 */
export type RateComponent =
  | "input"
  | "cachedInput"
  | "cacheWrite"
  | "output"
  | "speech"
  | "textTokens"
  | "audioTokens";

/**
 * How a TTS provider bills — the **billing model**, not a presentation choice.
 *
 * Each one measures a different thing, and the whole point of keeping them apart is that those
 * things are never interchangeable: a line of Mandarin is 12 characters, 36 UTF-8 bytes and some
 * number of text tokens nobody can work out from either figure.
 *
 *   chars         one rate per 1M **billable characters** — Unicode code points, not `String.length`
 *   bytes         one rate per 1M **UTF-8 bytes** — what Fish Audio actually meters
 *   tokens        one rate per 1M **input text tokens**, with no separate charge for the audio
 *   audio-tokens  two rates: input text tokens **and** output audio tokens, priced separately
 *   minute        one rate per minute of audio returned
 *   request       a flat fee per call, whatever it carried
 */
export type TtsBillingUnit = "chars" | "bytes" | "tokens" | "audio-tokens" | "minute" | "request";

/** Rates parked while another billing model is selected, so switching back restores them. */
export interface ParkedRates {
  rate: number | null;
  audioRate?: number | null;
}

export interface TtsBilling {
  unit: TtsBillingUnit;
  /**
   * The rate for `unit`: USD per 1M chars / 1M bytes / 1M input text tokens / per audio minute /
   * per request. On `audio-tokens` this is the **input text token** rate and `audioRate` carries
   * the other half.
   *
   * `null` = not known, which is never `0`. A local endpoint you host yourself is `0`; a provider
   * whose price list you have not typed in yet is `null`, and the difference is the difference
   * between "free" and "we cannot tell you what this cost".
   */
  rate: number | null;
  /** `audio-tokens` only: USD per 1M **output audio tokens**. `null` = not known. */
  audioRate?: number | null;
  /**
   * `audio-tokens` only: how many audio tokens one second of returned audio is billed as.
   *
   * Audio tokens cannot be derived from the text — a text-token approximation is simply a
   * different quantity — so an estimate has to go through the audio's expected **duration** and a
   * documented tokens-per-second figure. That figure is a per-model assumption, so it is editable
   * here rather than buried in the arithmetic, and every estimate that leans on it says so.
   */
  audioTokensPerSecond?: number;
  /**
   * Whether the voice instructions sent beside the line (a character's style, a line's direction)
   * are billed as part of the submitted content. Most providers that take an `instructions`
   * parameter meter it; some ignore it. Default `true` — see `measureSpeech`.
   */
  billsInstructions?: boolean;
  /**
   * Rates entered under a **different** billing model, kept rather than discarded.
   *
   * Switching model must never reinterpret a per-character rate as a per-token one, so the rate
   * fields are cleared on a switch instead of carried across — and parked here, so switching back
   * restores what was configured rather than making the operator type it again.
   */
  parked?: Partial<Record<TtsBillingUnit, ParkedRates>>;
}

/**
 * One complete rate card.
 *
 * Every entry is nullable and `null` always means the same thing: **this endpoint does not price
 * this separately**. For `cachedInput` and `cacheWrite` that means "charged at the ordinary input
 * rate" — not "free", which is `0`. For the token components on a speech card, and for `speech` on
 * an LLM card, it means the component does not apply at all.
 */
export interface RateSet {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  cacheWrite: number | null;
  /** the single rate of a `chars` / `bytes` / `minute` / `request` speech endpoint */
  speech: number | null;
  /** USD per 1M input text tokens, on a `tokens` or `audio-tokens` speech endpoint */
  textTokens: number | null;
  /** USD per 1M output audio tokens, on an `audio-tokens` speech endpoint */
  audioTokens: number | null;
}

/**
 * A recurring time window with its own rates — an off-peak discount, a peak surcharge.
 *
 * `from` and `to` are minutes past local midnight in the configuration's timezone. `to <= from`
 * means the window runs past midnight; `days` then names the day the window *starts* on, so a
 * Friday 22:00–02:00 window covers Friday night and the first two hours of Saturday.
 */
export interface RateWindow {
  id: string;
  label: string;
  /** 0 = Sunday … 6 = Saturday. Empty means every day. */
  days: number[];
  from: number;
  to: number;
  /** percentage off the base rates, 0–100. Negative would be a surcharge; use `rates` for that. */
  percent?: number;
  /** explicit replacement rates; wins over `percent` for the components it names */
  rates?: Partial<RateSet>;
}

/**
 * What a promotion is allowed to touch. `model` means every component this endpoint prices.
 *
 * `speech` means **the speech side as a whole** — the single rate of a per-character endpoint and
 * both halves of a token-billed one — so a promotion written before an endpoint moved to token
 * billing still discounts what it was meant to. `textTokens` and `audioTokens` target one half.
 */
export type PromotionScope = RateComponent | "model";

/**
 * A temporary price change with a start and an end — "50% off this model until Friday".
 *
 * An expired promotion is kept, not deleted: it stops applying the moment its end date passes, and
 * the requests it priced keep the rates they were priced at.
 */
export interface Promotion {
  id: string;
  label: string;
  /** epoch ms; null = it is already running */
  from: number | null;
  /** epoch ms; null = it has no end date */
  until: number | null;
  scope: PromotionScope[];
  /** percentage off whatever the schedule left, 0–100 */
  percent?: number;
  /** explicit replacement rates — these ignore the schedule for the components they name */
  rates?: Partial<RateSet>;
  /** free text kept with the promotion so an expired one still explains itself */
  note?: string;
}

/**
 * The advanced half of an endpoint's pricing. The two base rates stay on the profile itself
 * (`inPrice` / `outPrice`) so nothing that already reads them has to change; everything here is
 * what those two could not express.
 */
export interface PricingConfig {
  /** USD per 1M cached input tokens; null = no separate rate, charged as ordinary input.
   *  Meaningless on a speech endpoint, where it stays null and is not offered. */
  cachedInput: number | null;
  /** USD per 1M cache-write tokens; null = not billed separately, charged as ordinary input */
  cacheWrite: number | null;
  /** IANA timezone the windows below are read in — a schedule without one is unreadable */
  timezone: string;
  windows: RateWindow[];
  promotions: Promotion[];
}

/** One component's rate at one instant, and every step that moved it. */
export interface EffectiveComponent {
  component: RateComponent;
  /** null = this endpoint does not price this component separately */
  rate: number | null;
  base: number | null;
  /** after the schedule, before any promotion */
  scheduled: number | null;
  window: string | null;
  promotion: string | null;
  /** one short phrase per step that changed the rate, in the order they were applied */
  why: string[];
}

/** When the effective rates change next, and what changes. */
export interface PricingChange {
  at: number;
  label: string;
}

/** Every rate in force at one instant, why, and when it changes next. */
export interface PricingSnapshot {
  at: number;
  timezone: string;
  /** false when the configured timezone could not be read and UTC was used instead */
  timezoneOk: boolean;
  components: Record<RateComponent, EffectiveComponent>;
  window: RateWindow | null;
  /** promotions that actually moved a rate */
  applied: Promotion[];
  /** running and in scope, but beaten on every component they touch */
  shadowed: Promotion[];
  next: PricingChange | null;
}

// ---------- usage ----------

/** The provider payload shapes the prototype knows how to read. */
export type UsageFormat = "openai" | "anthropic" | "plain" | "internal";

export type UsageProblemCode =
  | "cache-not-reported"
  | "input-missing"
  | "output-missing"
  | "cache-exceeds-input"
  | "negative"
  /** the provider returned no usage block at all — the charge rests on what we counted */
  | "usage-not-reported"
  /** this endpoint bills on a quantity the provider did not report */
  | "billed-unit-missing"
  /** audio tokens were worked out from the audio's duration and the configured conversion */
  | "audio-tokens-estimated";

export interface UsageProblem {
  code: UsageProblemCode;
  /** one sentence, in the words the request detail shows */
  message: string;
  /** true when the counts had to be adjusted to stay self-consistent */
  repaired?: boolean;
}

/**
 * Normalized token usage for one request. **`inputTokens` is the total**, cached and cache-write
 * tokens included — they are parts of it, never additions to it. Charging is therefore
 *
 *     (inputTokens − cachedInput − cacheWrite) at the input rate
 *   +  cachedInput                             at the cached rate
 *   +  cacheWrite                              at the cache-write rate
 *   +  outputTokens                            at the output rate
 *
 * so no token is ever charged twice. `cachedInput: null` means the provider did not say — which is
 * different from `0`, meaning it said none were cached.
 */
export interface TokenUsage {
  inputTokens: number;
  cachedInput: number | null;
  cacheWrite: number | null;
  outputTokens: number;
  format: UsageFormat;
  problems: UsageProblem[];
  /** a charge the provider reported itself, when it reports one at all */
  reportedCost?: number | null;
}

// ---------- a priced request ----------

export interface CostLine {
  component: RateComponent;
  tokens: number;
  /** USD per 1M tokens */
  rate: number | null;
  amount: number | null;
  /** why these tokens are on this line rather than another */
  note?: string;
}

/**
 * Where a cost figure came from. `calculated` and `provider-reported` are deliberately separate:
 * one is our arithmetic on configured rates, the other is the provider's own number.
 */
export type CostBasis = "calculated" | "provider-reported" | "estimated" | "unknown";

/** One request's receipt. Written once, never recalculated. */
export interface PricedRequest {
  /** the instant the rates were read at */
  at: number;
  /** which instant that is, in words — the rule a future provider integration would adapt */
  rule: string;
  lines: CostLine[];
  /** what `basis` says this is: the calculated figure, or the provider's own */
  total: number | null;
  /** always our own arithmetic, even when the provider reported a different number */
  calculated: number | null;
  /** what the provider said it charged, when it said anything */
  reported: number | null;
  basis: CostBasis;
  /** what is not known about this figure, in sentences */
  unknowns: string[];
  usage: TokenUsage;
  /** the rates this request was charged at, frozen */
  rates: Record<RateComponent, EffectiveComponent>;
}

// ---------- what a speech request actually submitted, and what came back ----------

/**
 * The four quantities a speech provider can meter, kept apart on purpose.
 *
 * They are **not** conversions of one another and nothing here ever treats them as such: a line is
 * so many characters *and* so many UTF-8 bytes *and* so many text tokens, and only the one its
 * endpoint bills in is ever charged. Whichever model is in force, the other three are still
 * recorded — that is what makes it possible to change an endpoint's billing model and see what the
 * same traffic would have cost, without ever charging the same usage twice.
 *
 * `chars` is Unicode code points, not `String.length`: a JavaScript string counts an emoji as two
 * and a provider does not.
 */
export interface BillableUnits {
  /** billable characters — Unicode code points of everything submitted */
  chars: number;
  /** UTF-8 bytes of the same content */
  bytes: number;
  /** input text tokens; `null` when nothing has counted them */
  textTokens: number | null;
  /** generated audio, seconds. Silence stitched in locally is not generated and is never here. */
  audioSeconds: number;
  /** output audio tokens; `null` when the provider did not report them and none were estimated */
  audioTokens: number | null;
  /** how many calls the line became against the endpoint's per-request limit */
  requests: number;
  /** of `chars`, the part contributed by voice instructions rather than the line itself */
  instructionChars: number;
}

/** The speech payload shapes the prototype knows how to read. */
export type SpeechUsageFormat = "gemini" | "fish" | "plain" | "internal" | "none";

/**
 * Usage a speech provider reported for one completed request, normalized.
 *
 * Every field is independently nullable and `null` means **the provider did not say** — never
 * zero. A provider that returns no usage block at all (OpenAI's speech endpoint does not) leaves
 * every field null, and the charge is then worked out from what we measured on the way out and
 * labelled an estimate rather than presented as a reported fact.
 */
export interface SpeechUsage {
  chars: number | null;
  bytes: number | null;
  textTokens: number | null;
  audioSeconds: number | null;
  audioTokens: number | null;
  format: SpeechUsageFormat;
  problems: UsageProblem[];
  /** a charge the provider reported itself, when it reports one at all */
  reportedCost?: number | null;
}

/** Where one charged quantity's number came from. */
export type QuantitySource = "reported" | "measured" | "estimated";

/** One component of a speech charge: what was counted, at what rate, and why that rate. */
export interface SpeechChargeLine {
  component: RateComponent;
  /** how much was charged for, in this component's own unit */
  quantity: number;
  source: QuantitySource;
  /** the rate in force at the instant this was charged; `null` = not known */
  rate: number | null;
  /** the card rate, so the receipt can show what moved and by how much */
  base: number | null;
  /** one short phrase per step that moved the rate off the card, in order */
  why: string[];
  amount: number | null;
  /** why these units are on this line rather than another */
  note?: string;
}

/**
 * One rendered clip's receipt.
 *
 * Speech has no cache and no prompt/completion split, so a `PricedRequest` would be four-fifths
 * nulls and a `TokenUsage` full of zeros would be a lie. What a speech request is charged on is
 * what it submitted and what came back — characters, UTF-8 bytes, text tokens, audio seconds,
 * audio tokens, and how many requests a split line became — so all of that is recorded, beside the
 * rates in force when it landed and why those rates.
 *
 * `lines` is the whole charge: one line for a per-character endpoint, two for a token-billed one.
 * There is no second copy of the rate anywhere on this object, because two copies is how a receipt
 * starts disagreeing with itself.
 *
 * Written once, never recalculated: a bulk run renders hundreds of these and every one is kept.
 */
export interface SpeechCharge {
  at: number;
  rule: string;
  /** the billing model in force when this landed, frozen — a later change cannot rewrite it */
  unit: TtsBillingUnit;
  /** the audio-token assumption this was charged under, when it was charged on audio tokens */
  audioTokensPerSecond?: number;
  /** everything that was measured, whether or not this model bills for it */
  units: BillableUnits;
  /** what the provider itself said, when it said anything */
  reported: SpeechUsage | null;
  lines: SpeechChargeLine[];
  amount: number | null;
  basis: CostBasis;
  unknowns: string[];
}

/**
 * One charged line, ready to render, whatever it was charged for.
 *
 * The Activity list shows the same table for both kinds of endpoint, and the two kinds measure
 * different things — tokens against characters or audio minutes. This is the shape they meet in, so
 * there is one table rather than two.
 */
export interface ChargeLine {
  label: string;
  /** what was charged for, with its unit spelled out: "8,000 tokens", "1,240 characters" */
  quantity: string;
  /** the rate with its unit: "$0.15 / 1M tokens", "$12.00 per 1M characters" */
  rate: string;
  amount: number | null;
  /** what moved the rate off the card, in order */
  why: string[];
  note?: string;
}

// ---------- estimates ----------

/**
 * What a run would cost before it is sent, when cache usage cannot be known. The headline figure
 * assumes **no** cache savings; anything cheaper is offered beside it and labelled.
 */
export interface RateEstimate {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  /** the conservative total: every input token at the ordinary rate */
  cost: number;
  /** the same work if cached input ran at a recently observed hit rate; null when neither applies */
  withObservedCache: { hitRate: number; cost: number; samples: number } | null;
  /**
   * The ceiling: every promotion expired, every schedule window gone, and every input token at the
   * dearest rate any input token can be charged at on this card — cached and cache-write tokens are
   * slices of the input and are not always cheaper than it. This is what a budget must survive, and
   * what a reservation is taken at.
   */
  withoutPromotions: number;
  /** what could move this figure between now and the last request, in sentences */
  cautions: string[];
}

/**
 * What a speech run would cost before anything is sent.
 *
 * The two halves are kept apart because on a token-billed endpoint they are worked out completely
 * differently — the input side from the text that will be submitted, the audio side from the
 * audio's expected duration and the endpoint's tokens-per-second assumption — and adding them up
 * without showing the split is how "why is this $19?" becomes unanswerable.
 */
export interface SpeechEstimate {
  /** the input-text half: characters, bytes, text tokens or the flat per-request fee */
  inputCost: number | null;
  /** the output-audio half: audio minutes or audio tokens. `null` when this model has none. */
  audioCost: number | null;
  /** `inputCost + audioCost`; null when a rate this model needs is not known */
  cost: number | null;
  /** the same run with every discount gone — what a budget is checked against */
  withoutPromotions: number | null;
  units: BillableUnits;
  /** what could move this figure before the last clip lands, in sentences */
  cautions: string[];
}
