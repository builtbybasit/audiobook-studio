// What a line of narration is expected to submit, and the figure a budget holds against it.
//
// The browser's estimate and the server's reservation are the same calculation, so it lives here
// once: a panel that works a line out one way and a gate that works it out another is how a run the
// panel green-lit is refused, or a run the panel warned about goes through.
import type { BillableUnits, Endpoint, SpeechEstimate } from "@/types";
import { billingOf } from "@/lib/endpoints";
import { expressionParts, type ExpressionPlan } from "@/lib/expressions";
import { AUDIO_CHARS_PER_SECOND, measureSpeech } from "@/lib/pricing";
import { partsFor } from "@/lib/split";

/**
 * What one line would submit to `ep`, counted every way a provider can bill it.
 *
 * The line **after** the pronunciation dictionary and the expression tags (`render`), plus the
 * voice instructions sent beside it — never the source text. It is as many requests as the
 * endpoint's limit cuts it into; the audio side is this app's reading-speed estimate, because
 * nothing has been rendered yet. A line whose tags the endpoint cannot say is still counted, cut
 * the plain way, so an estimate never reads cheaper for a line that needs attention.
 */
export function plannedSpeechUnits(
  render: ExpressionPlan,
  ep: Endpoint,
  instructions: string,
): BillableUnits {
  const parts = render.issues.length
    ? partsFor(render.text, ep)
    : expressionParts(render, ep).length;
  return measureSpeech(
    {
      text: render.text,
      instructions,
      requests: parts,
      audioSeconds: render.text.length / AUDIO_CHARS_PER_SECOND,
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
