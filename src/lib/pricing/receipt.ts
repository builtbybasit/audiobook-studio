// What one request cost: usage × the rates in force when it completed, kept as a receipt.
//
// A receipt is worked out once and kept, never recalculated: the same inputs always give the same
// figure, and a rate that changes afterwards does not reach a request that was already charged.
import type {
  BillableUnits,
  CostBasis,
  CostLine,
  PricedRequest,
  PricingConfig,
  QuantitySource,
  RateComponent,
  RateSet,
  SpeechCharge,
  SpeechChargeLine,
  SpeechUsage,
  TokenUsage,
  TtsBilling,
  TtsBillingUnit,
} from "@/types";
import { effectiveRates, resolveAll, speechRates } from "./rates";
import {
  audioTokensPerSecondOf,
  billsAudioTokens,
  componentAmount,
  quantityFor,
  speechComponents,
} from "./units";
import { USAGE_PROBLEM, uncachedInput, usageTrustworthy } from "./usage";

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

// ---------- pricing one speech request ----------

export interface SpeechPriceOptions extends PriceOptions {
  /** what the provider reported for this request, when it reported anything */
  reported?: SpeechUsage | null;
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
    unknowns.push(USAGE_PROBLEM["audio-tokens-estimated"]);
  else if (reported && reported.problems.some((p) => p.code === "usage-not-reported"))
    unknowns.push(USAGE_PROBLEM["usage-not-reported"]);
  else if (reported && lines.some((l) => l.source !== "reported") && basis !== "unknown")
    unknowns.push(USAGE_PROBLEM["billed-unit-missing"]);

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
