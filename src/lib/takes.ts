// The lifecycle of one rendered clip. Pure functions on `SegmentAudio`, shared by the store's
// retake actions and by the narration simulator, so a clip put back in the queue by a retry and one
// put back by a rate limit end up in exactly the same state.
import type { SegmentAudio, Take } from "@/types";

/** Back to the queue without losing the take history or a comparison in progress. */
export const requeue = (a: SegmentAudio): SegmentAudio => ({
  status: "queued",
  endpoint: null,
  ms: 0,
  duration: 0,
  ...(a.takes?.length ? { takes: a.takes } : {}),
  ...(a.n ? { n: a.n } : {}),
});

/** Freeze what `audio` currently holds so it survives the next render. */
export const snapshotTake = (a: SegmentAudio): Take => ({
  n: a.n ?? 1,
  at: a.at ?? Date.now(),
  ms: a.ms,
  duration: a.duration,
  cost: a.cost,
  endpoint: a.endpoint,
  voiceRef: a.voiceRef,
  voice: a.voice,
  model: a.model,
  direction: a.direction,
  style: a.style,
  type: a.type,
  text: a.text,
  said: a.said,
  pronounced: a.pronounced,
  expressionSignature: a.expressionSignature,
  expressions: a.expressions,
});
