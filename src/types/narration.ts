// Narration estimates. Cost and load are per endpoint: each segment goes to the endpoint that owns
// its speaker's voice, and a segment longer than that endpoint's limit becomes several requests.
import type { Endpoint } from "@/types/endpoint";

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
  chapters: number;
  chars: number;
  segments: number;
  seconds: number;
  cost: number;
  stale: number;
  unrouted: number;
  requests: number;
  split: number;
  endpoints: number;
  per: EndpointEstimate[];
}
