// What a run would cost before anything is sent. Cache use and audio length are only known
// afterwards, so each figure says what it assumed; budgets check `withoutPromotions`, the dearest
// the card can reach during the run.
import { stamp } from "@/lib/wallClock";
import type {
  BillableUnits,
  PricingConfig,
  RateComponent,
  RateEstimate,
  RateSet,
  SpeechEstimate,
  TokenUsage,
  TtsBilling,
} from "@/types";
import { money } from "./format";
import { EPSILON, ceilingRates, dearestInput, effectiveRates, speechRates } from "./rates";
import {
  audioTokensPerSecondOf,
  billsAudioTokens,
  componentAmount,
  quantityFor,
  speechComponents,
} from "./units";

/**
 * The headline figure assumes no cache use. A figure from recently observed cache use is offered
 * beside it, never used for a budget check.
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

  // the dearest the card can reach (`ceilingRates`), every input token at `dearestInput`
  const ceiling = ceilingRates(base, config);
  const withoutPromotions =
    (tokens.inputTokens / 1e6) * (dearestInput(ceiling) ?? 0) +
    (tokens.outputTokens / 1e6) * (ceiling.output ?? 0);

  // a window later on (a peak hour) charges more than the rates in force now
  const dearerLater =
    (ceiling.input ?? 0) > inRate + EPSILON || (ceiling.output ?? 0) > outRate + EPSILON;
  const cautions: string[] = [];
  // "no cache savings" is only a ceiling when cached and cache-write rates are not dearer
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
  else if (!inputIsCeiling || dearerLater)
    cautions.push(
      `Budget checks use ${money(withoutPromotions)}, ${[
        dearerLater ? "the rates of this endpoint's dearest hours" : "",
        inputIsCeiling ? "" : "every input token at the dearest rate this endpoint charges for one",
      ]
        .filter(Boolean)
        .join(" and ")}, so no request can cost more than it reserved.`,
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
 * Exact for text-billed units; per-minute and audio-token billing rest on estimated audio length
 * (and the tokens-per-second setting). The halves come back separately (`inputCost` + `audioCost`)
 * so a total does not hide which is large.
 */
export function estimateSpeech(
  billing: TtsBilling,
  config: PricingConfig,
  units: BillableUnits,
  at: number,
): SpeechEstimate {
  const components = speechComponents(billing.unit);
  const audioSide = (c: RateComponent) => c === "audioTokens" || billing.unit === "minute";

  const priceWith = (rateOf: (c: RateComponent) => number | null) => {
    let input: number | null = null;
    let audio: number | null = null;
    let known = true;
    for (const c of components) {
      const amount = componentAmount(
        c,
        billing.unit,
        quantityFor(c, billing.unit, units),
        rateOf(c),
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
  const now = priceWith((c) => snapshot.components[c].rate);
  const ceiling = ceilingRates(speechRates(billing), config);
  const bare = priceWith((c) => ceiling[c]);

  const cautions: string[] = [];
  if (snapshot.next)
    cautions.push(
      `Rates change at ${stamp(snapshot.next.at, config.timezone)} — ${snapshot.next.label.toLowerCase()}. A run still going then straddles it.`,
    );
  if (snapshot.applied.length && now.total != null && bare.total != null)
    cautions.push(
      `${snapshot.applied.length === 1 ? "A promotion is" : `${snapshot.applied.length} promotions are`} in force. Budget checks use ${money(bare.total)}, the price without ${snapshot.applied.length === 1 ? "it" : "them"}, so a promotion ending mid-run cannot overshoot a cap.`,
    );
  else if (now.total != null && bare.total != null && bare.total > now.total + EPSILON)
    cautions.push(
      `Budget checks use ${money(bare.total)}, the rates of this endpoint's dearest hours, so a run still going when they start cannot overshoot a cap.`,
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

// ---------- observed cache use ----------

/** Only requests that reported cache detail count: silence is not a cache miss. */
export function observedCacheRate(
  recent: TokenUsage[],
): { hitRate: number; samples: number } | null {
  const reported = recent.filter((u) => u.cachedInput != null && u.inputTokens > 0);
  if (!reported.length) return null;
  const input = reported.reduce((n, u) => n + u.inputTokens, 0);
  const cached = reported.reduce((n, u) => n + (u.cachedInput ?? 0), 0);
  return input > 0 ? { hitRate: cached / input, samples: reported.length } : null;
}
