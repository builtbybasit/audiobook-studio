// Narration estimates. Cost and load are per endpoint: each segment goes to the endpoint that owns
// its speaker's voice, and a segment longer than that endpoint's limit becomes several requests.
import type { Endpoint } from "@/types/endpoint";
import type { BillableUnits } from "@/types/pricing";
import type { NarrationScope } from "@/types/run";

/** Per-endpoint slice of a narration estimate. */
export interface EndpointEstimate {
  endpoint: Endpoint;
  /**
   * What this endpoint's share would submit, counted every way a provider can bill it — characters,
   * UTF-8 bytes, text tokens, expected audio seconds and audio tokens. All of them, whichever one
   * this endpoint actually bills on, so the panel can say why a byte-billed endpoint costs more
   * than its character count suggests.
   */
  units: BillableUnits;
  /** billable characters of this share; the same number as `units.chars`, kept for existing readers */
  chars: number;
  segments: number;
  requests: number;
  /** segments that exceed the endpoint's limit and become several requests */
  split: number;
  /** what this endpoint's share would cost at the rates in force now; null = its rate is unknown */
  cost: number | null;
  /** the input-text half of that: characters, bytes, text tokens or the per-request fee */
  inputCost: number | null;
  /** the output-audio half: audio minutes or audio tokens. `null` = this model has no audio side. */
  audioCost: number | null;
  /** the same share with no discount — what a budget has to be able to cover */
  withoutPromotions: number | null;
  /** one short phrase per step that moved this endpoint off its card rate */
  why: string[];
}

export interface NarrationEstimate {
  /** chapters that will actually run — not every chapter that was ticked */
  chapters: number;
  /**
   * Source-text length, in JavaScript string units. This is how long the chapter **is**, which is
   * what `seconds` is worked out from — not what anybody is charged for. The billable counts are
   * `units`, taken from the text that will actually be submitted.
   */
  chars: number;
  /**
   * What this run would submit, counted every way a provider can bill it, added across every
   * endpoint in it. `units.chars` and `chars` are deliberately different numbers: the dictionary
   * rewrites words on the way out, expression tags are inserted, and voice instructions travel
   * with the request — none of which is in the book.
   */
  units: BillableUnits;
  /** lines this run will render, at the chosen scope */
  segments: number;
  seconds: number;
  /**
   * What this run would cost at the rates in force now. A **floor**, not the bill, when
   * `unpriced` is non-zero: an endpoint with no rate is counted and never priced.
   */
  cost: number;
  /**
   * The two halves of `cost`, kept apart because on a token-billed endpoint they are worked out
   * from completely different things: the input side from the text that will be submitted, the
   * audio side from the audio's expected length and the endpoint's tokens-per-second assumption.
   * `audioCost` is `null` when nothing in this run bills on the audio at all.
   */
  inputCost: number;
  audioCost: number | null;
  /** requests routed to an endpoint whose rate is not known, so they are missing from `cost` */
  unpriced: number;
  /** the same run with every discount gone — what the budget is checked against */
  withoutPromotions: number;
  /** what could move the figure before the last clip lands, in sentences */
  cautions: string[];
  stale: number;
  /** lines whose current clip stays playable until its replacement succeeds */
  replacing: number;
  /** lines left alone because a retake is waiting for a verdict */
  pending: number;
  /** the scope these numbers were counted for */
  scope: NarrationScope;
  unrouted: number;
  requests: number;
  split: number;
  endpoints: number;
  per: EndpointEstimate[];
}
