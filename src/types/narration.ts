// Narration estimates. Cost and load are per endpoint: each segment goes to the endpoint that owns
// its speaker's voice, and a segment longer than that endpoint's limit becomes several requests.
import type { Endpoint } from "@/types/endpoint";
import type { NarrationScope } from "@/types/run";

/** Per-endpoint slice of a narration estimate. */
export interface EndpointEstimate {
  endpoint: Endpoint;
  chars: number;
  segments: number;
  requests: number;
  /** segments that exceed the endpoint's limit and become several requests */
  split: number;
}

export interface NarrationEstimate {
  /** chapters that will actually run — not every chapter that was ticked */
  chapters: number;
  chars: number;
  /** lines this run will render, at the chosen scope */
  segments: number;
  seconds: number;
  cost: number;
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
