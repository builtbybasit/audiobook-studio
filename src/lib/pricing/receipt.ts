// What one request cost: usage × the rates in force when it completed. A receipt is worked out
// once and kept, never recalculated, so a later rate change never reaches it.
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

/** Recorded on every receipt, so the rule travels with the figure. */
export const PRICING_RULE = "priced at the rates in force when the request completed";

export interface PriceOptions {
  /** the caller decides, and says so with `rule` */
  at: number;
  rule?: string;
  /** trust a charge the provider reported over our own arithmetic */
  preferReported?: boolean;
}

/** The result is a receipt: keep it, never redo it. */
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
    // an assumed cache miss is labelled an estimate, never presented as fact
    push(
      "input",
      usage.inputTokens - written,
      r.input.rate,
      "the provider did not report cached tokens, so all of it is charged at the ordinary rate",
    );
    // only an upper bound when the cached rate is not dearer than the ordinary one
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
  reported?: SpeechUsage | null;
}

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
 * What one clip cost, at the rates in force when it landed. "calculated" means every quantity was
 * reported or counted exactly; "estimated" means one was derived (audio tokens from duration, text
 * tokens from characters). A failed clip has 0 audio seconds but still pays for what was sent.
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

/** Every step that moved this charge's rates off the card, in order. */
export const speechWhy = (charge: SpeechCharge): string[] => [
  ...new Set(charge.lines.flatMap((l) => l.why)),
];
