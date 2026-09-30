// The rate in force at a given instant, and why.
//
// A rate card (`RateSet`) with its schedule and promotions (`PricingConfig`) is evaluated at an
// instant here and nowhere else: `effectiveRates` for what is charged now and every step that moved
// it, `ceilingRates` for the dearest it can get, `nextChange` for when it moves next. The precedence
// rule is `resolveComponent`, and `index.ts` says it in words.
import { localClock, localTimezone } from "@/lib/wallClock";
import type {
  EffectiveComponent,
  PricingChange,
  PricingConfig,
  PricingSnapshot,
  Promotion,
  PromotionScope,
  RateComponent,
  RateSet,
  RateWindow,
  TtsBilling,
  TtsBillingUnit,
} from "@/types";
import { rateWithUnit } from "./format";
import { RATE_COMPONENTS, speechComponents } from "./units";

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

// ---------- what a promotion covers ----------

/**
 * Does this promotion touch this component?
 *
 * `speech` is the speech side as a whole rather than one named component: a promotion written when
 * an endpoint billed per character still discounts it after it moves to token billing, which is
 * the reading an operator means by "20% off speech". `textTokens` and `audioTokens` target one half.
 */
export const inScope = (p: Promotion, c: RateComponent): boolean =>
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
export function promotionRate(
  p: Promotion,
  c: RateComponent,
  scheduled: number | null,
): number | null {
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

/** How far apart two rates must be to count as different, so float noise never picks a winner. */
export const EPSILON = 1e-12;

function endsSooner(p: Promotion, against: Promotion | null): boolean {
  if (!against) return true;
  return (p.until ?? Infinity) < (against.until ?? Infinity);
}

/**
 * Every component resolved at one instant, without the `next` lookahead — what a receipt needs,
 * without the fortnight of boundaries `effectiveRates` searches for the card.
 */
export function resolveAll(
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
 * The dearest rate each component can reach on this card, at any instant.
 *
 * Not the base card. A window can raise a rate as well as lower one — DeepSeek's card is its
 * off-peak price, and the peak windows put the full one back at twice that — so "every discount
 * gone" is not "every window gone", and a reservation taken at the base card would be half of
 * what a peak-hour request costs. Every window is tried, and none, each with every promotion on
 * its own and with none. A promotion never makes a rate dearer than the schedule left it
 * (`resolveComponent` drops one that would), so trying them costs nothing and keeps this true
 * whatever that rule becomes. A component with no base rate stays `null`.
 */
export function ceilingRates(base: RateSet, config: PricingConfig): RateSet {
  const ceiling = { ...base };
  for (const window of [null, ...config.windows])
    for (const running of [[], ...config.promotions.map((p) => [p])])
      for (const c of RATE_COMPONENTS) {
        if (base[c] == null) continue;
        const rate = resolveComponent(c, base, window, running).effective.rate;
        if (rate != null && rate > (ceiling[c] ?? -Infinity)) ceiling[c] = rate;
      }
  return ceiling;
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
