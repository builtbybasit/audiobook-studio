// Narration estimates. Cost and load are per endpoint: each segment goes to the endpoint that owns
// its speaker's voice, and a segment longer than that endpoint's limit becomes several requests.
import type { Endpoint } from "@/types/endpoint";
import type { BillableUnits } from "@/types/pricing";
import type { NarrationScope } from "@/types/run";

/** Per-endpoint slice of a narration estimate. */
export interface EndpointEstimate {
  endpoint: Endpoint;
  /**
   * Every unit a provider can bill on, so the panel can explain e.g. a byte-billed endpoint's cost.
   */
  units: BillableUnits;
  /** same as `units.chars`, kept for existing readers */
  chars: number;
  segments: number;
  requests: number;
  /** segments over the endpoint's limit that become several requests */
  split: number;
  /** at the rates in force now; null = its rate is unknown */
  cost: number | null;
  /** characters, bytes, text tokens or the per-request fee */
  inputCost: number | null;
  /** audio minutes or audio tokens; `null` = this model has no audio side */
  audioCost: number | null;
  /** no discount; what a budget has to cover */
  withoutPromotions: number | null;
  /** one short phrase per step that moved this endpoint off its card rate */
  why: string[];
}

export interface NarrationEstimate {
  /** chapters that will actually run, not every one ticked */
  chapters: number;
  /** Source length in JS string units, which `seconds` comes from. Billable counts are `units`. */
  chars: number;
  /**
   * Summed across endpoints. `units.chars` differs from `chars` on purpose: the dictionary,
   * expression tags and voice instructions change what is submitted.
   */
  units: BillableUnits;
  /** at the chosen scope */
  segments: number;
  seconds: number;
  /** At the rates in force now. A **floor** when `unpriced` is non-zero. */
  cost: number;
  /** `cost` split as on `SpeechEstimate`; `audioCost` is `null` when nothing bills on audio. */
  inputCost: number;
  audioCost: number | null;
  /** requests to an endpoint with no known rate, missing from `cost` */
  unpriced: number;
  /** the same run with every discount gone */
  withoutPromotions: number;
  /**
   * What the book's cap is checked against: `Σ max(cost, withoutPromotions)` **per endpoint**. The
   * max over the totals can sit under what `_budgetBlocked` refuses the run on.
   */
  worstCase: number;
  cautions: string[];
  stale: number;
  /** lines whose current clip stays playable until its replacement succeeds */
  replacing: number;
  /** lines left alone because a retake is waiting for a verdict */
  pending: number;
  scope: NarrationScope;
  unrouted: number;
  requests: number;
  split: number;
  per: EndpointEstimate[];
}
