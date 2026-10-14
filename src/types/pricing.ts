// What an endpoint charges (the rate card), what the provider reported (usage), and what one
// request cost (a receipt: usage × the rates at one instant, never recalculated, so editing a rate
// today cannot move yesterday's spending).

/**
 * The first four are LLM rates, USD per 1M tokens. `speech` is a TTS endpoint's single rate, in
 * whatever unit it bills. Components of the side a card does not price stay `null`.
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
 * How a TTS provider bills. The units are never interchangeable: `chars` is Unicode code points
 * (not `String.length`), `bytes` is UTF-8 (what Fish Audio meters), `audio-tokens` prices input
 * text tokens and output audio tokens separately.
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
   * USD per 1M of `unit`, per audio minute, or per request. On `audio-tokens` this is the input
   * text token rate. `null` = not known, which is not `0` (free, e.g. a self-hosted endpoint).
   */
  rate: number | null;
  /** `audio-tokens` only: USD per 1M **output audio tokens**. `null` = not known. */
  audioRate?: number | null;
  /**
   * `audio-tokens` only: audio tokens billed per second of audio. Audio tokens can't be derived
   * from text, so estimates go through expected duration; this per-model assumption is editable.
   */
  audioTokensPerSecond?: number;
  /** Whether voice instructions sent with a line are billed. Default `true` (`measureSpeech`). */
  billsInstructions?: boolean;
  /**
   * Rates entered under another billing model. A switch clears the rate fields (a per-character
   * rate must never be read as a per-token one) and parks them here for switching back.
   */
  parked?: Partial<Record<TtsBillingUnit, ParkedRates>>;
}

/**
 * `null` means "not priced separately": for `cachedInput`/`cacheWrite` that is the ordinary input
 * rate (not free, which is `0`); for the other side's components it means they don't apply.
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
 * A recurring window with its own rates. `from`/`to` are minutes past local midnight; `to <= from`
 * runs past midnight, and `days` names the day the window starts on.
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
 * `model` means every component this endpoint prices. `speech` means the whole speech side (both
 * halves of a token-billed one), so it survives a switch to token billing.
 */
export type PromotionScope = RateComponent | "model";

/** A temporary price change. An expired one is kept; the requests it priced keep their rates. */
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
  note?: string;
}

/** Advanced pricing; the base rates stay on the profile (`inPrice` / `outPrice`). */
export interface PricingConfig {
  /**
   * USD per 1M cached input tokens; null = charged as ordinary input. Unused on speech endpoints.
   */
  cachedInput: number | null;
  /** USD per 1M cache-write tokens; null = charged as ordinary input */
  cacheWrite: number | null;
  /** IANA timezone the windows are read in */
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

export type UsageFormat = "openai" | "anthropic" | "plain" | "internal";

export type UsageProblemCode =
  | "cache-not-reported"
  | "input-missing"
  | "output-missing"
  | "cache-exceeds-input"
  | "negative"
  /** no usage block at all; the charge rests on what we counted */
  | "usage-not-reported"
  /** this endpoint bills on a quantity the provider did not report */
  | "billed-unit-missing"
  /** worked out from the audio's duration and the configured conversion */
  | "audio-tokens-estimated";

export interface UsageProblem {
  code: UsageProblemCode;
  message: string;
  /** true when the counts had to be adjusted to stay self-consistent */
  repaired?: boolean;
}

/**
 * **`inputTokens` is the total**: cached and cache-write tokens are parts of it, so the input rate
 * applies to `inputTokens − cachedInput − cacheWrite`. `cachedInput: null` = the provider did not
 * say; `0` = it said none.
 */
export interface TokenUsage {
  inputTokens: number;
  cachedInput: number | null;
  cacheWrite: number | null;
  outputTokens: number;
  /** of `outputTokens`, spent reasoning; null or absent when the provider did not say */
  reasoningTokens?: number | null;
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

/** `calculated`: our arithmetic on configured rates; `provider-reported`: the provider's number. */
export type CostBasis = "calculated" | "provider-reported" | "estimated" | "unknown";

/** One request's receipt. Written once, never recalculated. */
export interface PricedRequest {
  /** the instant the rates were read at */
  at: number;
  /** which instant that is, in words */
  rule: string;
  lines: CostLine[];
  /** what `basis` says this is: the calculated figure, or the provider's own */
  total: number | null;
  /** always our own arithmetic, even when the provider reported a different number */
  calculated: number | null;
  reported: number | null;
  basis: CostBasis;
  unknowns: string[];
  usage: TokenUsage;
  /** the rates this request was charged at, frozen */
  rates: Record<RateComponent, EffectiveComponent>;
}

// ---------- what a speech request actually submitted, and what came back ----------

/**
 * Every quantity a speech provider can meter; not conversions of one another. Only the billing
 * unit is charged, but all are recorded so a billing-model change can be compared.
 */
export interface BillableUnits {
  /** Unicode code points of everything submitted (a JS string counts an emoji as two) */
  chars: number;
  bytes: number;
  /** `null` when nothing has counted them */
  textTokens: number | null;
  /** generated audio only; silence stitched in locally is never here */
  audioSeconds: number;
  /** `null` when the provider did not report them and none were estimated */
  audioTokens: number | null;
  /** how many calls the line became against the endpoint's per-request limit */
  requests: number;
  /** of `chars`, the part contributed by voice instructions rather than the line itself */
  instructionChars: number;
}

export type SpeechUsageFormat = "gemini" | "fish" | "plain" | "internal" | "none";

/**
 * `null` = the provider did not say, never zero. With no usage block at all (OpenAI speech), the
 * charge comes from what we measured and is labelled an estimate.
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

export type QuantitySource = "reported" | "measured" | "estimated";

export interface SpeechChargeLine {
  component: RateComponent;
  /** in this component's own unit */
  quantity: number;
  source: QuantitySource;
  /** the rate in force at the instant this was charged; `null` = not known */
  rate: number | null;
  /** the card rate */
  base: number | null;
  /** one short phrase per step that moved the rate off the card, in order */
  why: string[];
  amount: number | null;
  note?: string;
}

/**
 * One rendered clip's receipt. `lines` is the whole charge (one line, or two when token-billed);
 * the rate lives only there so the receipt can't disagree with itself. Never recalculated.
 */
export interface SpeechCharge {
  at: number;
  rule: string;
  /** the billing model in force when this landed */
  unit: TtsBillingUnit;
  audioTokensPerSecond?: number;
  /** everything measured, whether or not this model bills for it */
  units: BillableUnits;
  reported: SpeechUsage | null;
  lines: SpeechChargeLine[];
  amount: number | null;
  basis: CostBasis;
  unknowns: string[];
}

/** One charged line ready to render, shared by LLM and speech receipts in the Activity table. */
export interface ChargeLine {
  label: string;
  /** with its unit: "8,000 tokens", "1,240 characters" */
  quantity: string;
  /** with its unit: "$0.15 / 1M tokens" */
  rate: string;
  amount: number | null;
  why: string[];
  note?: string;
}

// ---------- estimates ----------

/** A pre-send estimate. The headline `cost` assumes no cache savings. */
export interface RateEstimate {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  /** every input token at the ordinary rate */
  cost: number;
  /** the same work if cached input ran at a recently observed hit rate; null when neither applies */
  withObservedCache: { hitRate: number; cost: number; samples: number } | null;
  /**
   * The ceiling a budget and a reservation use: promotions expired, the dearest window
   * (`ceilingRates`), and every input token at the dearest input-side rate (cache rates can be
   * dearer than input).
   */
  withoutPromotions: number;
  cautions: string[];
}

/**
 * Input and audio halves stay apart: on a token-billed endpoint the audio half comes from expected
 * duration × tokens-per-second, not the text.
 */
export interface SpeechEstimate {
  /** characters, bytes, text tokens or the flat per-request fee */
  inputCost: number | null;
  /** audio minutes or audio tokens; `null` when this model has none */
  audioCost: number | null;
  /** null when a rate this model needs is not known */
  cost: number | null;
  /** every discount gone; what a budget is checked against */
  withoutPromotions: number | null;
  units: BillableUnits;
  cautions: string[];
}

// ---------- a book's spending ----------

/** `GET /api/books/:id/spend`, in USD, summed on the server from the ledger and the queue. */
export interface BookSpend {
  /** both kinds of request, plus the opening balance */
  spent: number;
  scriptSpent: number;
  speechSpent: number;
  /** spending recorded before the ledger, which no request row explains */
  opening: number;
  /** held by unfinished jobs of either kind, at undiscounted rates */
  reserved: number;
  /** of `reserved`, held by scripting jobs; what the script budget is checked against */
  scriptReserved: number;
  /** settled requests whose cost is not known, so `spent` is a floor */
  unpriced: number;
}
