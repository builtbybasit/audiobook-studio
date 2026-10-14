// Rate-card checks in the form's words: problems block a save, warnings only say so.
import { timezoneValid } from "@/lib/wallClock";
import type { PricingConfig, RateSet, TtsBilling } from "@/types";
import { COMPONENT_LABEL } from "./format";
import { inScope, promotionRate, promotionRunning } from "./rates";
import { RATE_COMPONENTS, billsAudioTokens } from "./units";

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

/** An unknown rate is not a problem: it is a legitimate state the page reports. */
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
  // only components this card prices
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
  // only on a card that prices something, else the scope is blamed for a missing rate
  const priced = RATE_COMPONENTS.filter((c) => base[c] != null);
  if (priced.length)
    for (const p of running)
      if (!p.scope.includes("model") && !priced.some((c) => inScope(p, c)))
        out.push(
          `“${p.label}” is running but applies to nothing this endpoint prices. Check its scope.`,
        );
  return [...new Set(out)];
}
