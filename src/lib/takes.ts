// The lifecycle of one rendered clip, shared by the store's retakes and the server's narration so
// both leave a clip in the same state.
import type { SegmentAudio, Take } from "@/types";

/** Back to the queue without losing the take history or a comparison in progress. */
export const requeue = (a: SegmentAudio): SegmentAudio => ({
  status: "queued",
  endpoint: null,
  ms: 0,
  duration: 0,
  ...(a.takes?.length ? { takes: a.takes } : {}),
  ...(a.n ? { n: a.n } : {}),
  // a rate limit puts a bulk replacement back in the queue; it is still a replacement afterwards
  ...(a.auto ? { auto: true } : {}),
});

/** One past the highest seen, takes included, so a rejected take's number is never reused. */
export const nextTakeNumber = (a: SegmentAudio): number =>
  Math.max(a.n ?? 1, ...(a.takes ?? []).map((t) => t.n)) + 1;

/** Freeze `audio` so it survives the next render; its `charge` comes too, as it was paid for. */
export const snapshotTake = (a: SegmentAudio): Take => ({
  n: a.n ?? 1,
  at: a.at ?? Date.now(),
  ms: a.ms,
  duration: a.duration,
  cost: a.cost,
  ...(a.charge ? { charge: a.charge } : {}),
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
  sampleRate: a.sampleRate,
  sound: a.sound,
});
