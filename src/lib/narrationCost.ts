// What a line of narration is expected to submit, and what a budget holds against it. The
// browser's estimate and the server's reservation share it so they cannot disagree.
import type { BillableUnits, Endpoint, SpeechEstimate } from "@/types";
import { billingOf } from "@/lib/endpoints";
import { AUDIO_CHARS_PER_SECOND, measureSpeech } from "@/lib/pricing";
import type { Reading } from "@/lib/reading";

/** From the reading as sent, never the source text; audio length is the reading-speed estimate. */
export function plannedSpeechUnits(reading: Reading, ep: Endpoint): BillableUnits {
  const { plan, instructions, requests } = reading;
  return measureSpeech(
    {
      text: plan.text,
      instructions,
      requests,
      audioSeconds: plan.text.length / AUDIO_CHARS_PER_SECOND,
    },
    billingOf(ep),
  );
}

/**
 * The dearer of today's price and the price without promotions: a discount can end mid-run. An
 * unknown half adds nothing, so the figure is a floor rather than a refusal.
 */
export const worstCaseOf = (priced: Pick<SpeechEstimate, "cost" | "withoutPromotions">): number =>
  Math.max(priced.cost ?? 0, priced.withoutPromotions ?? 0);
