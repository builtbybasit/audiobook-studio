// What a line of narration is expected to submit, and the figure a budget holds against it.
//
// The browser's estimate and the server's reservation are the same calculation, so it lives here
// once: a panel that works a line out one way and a gate that works it out another is how a run the
// panel green-lit is refused, or a run the panel warned about goes through.
import type { BillableUnits, Endpoint, SpeechEstimate } from "@/types";
import { billingOf } from "@/lib/endpoints";
import { AUDIO_CHARS_PER_SECOND, measureSpeech } from "@/lib/pricing";
import type { Reading } from "@/lib/reading";

/**
 * What one line would submit to `ep`, counted every way a provider can bill it.
 *
 * The line's reading (`@/lib/reading`): the words **after** the pronunciation dictionary and the
 * expression tags, plus the voice instructions sent beside them — never the source text — in as
 * many requests as the reading says it is billed as. The audio side is this app's reading-speed
 * estimate, because nothing has been rendered yet.
 */
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
 * The figure a budget holds for one estimate: the dearer of today's price and the price without
 * promotions, because a run lasts long enough for a discount to end inside it. A half that is not
 * known adds nothing, which makes the figure a floor rather than a refusal.
 */
export const worstCaseOf = (priced: Pick<SpeechEstimate, "cost" | "withoutPromotions">): number =>
  Math.max(priced.cost ?? 0, priced.withoutPromotions ?? 0);
