// A chapter's narration as everything that renders or judges a clip reads it: which slot a line
// renders into, what counts as in flight, and how the chapter adds itself up afterwards.
//
// The narration job (`server/jobs/narration.ts`), a retake and its verdict (`ops.ts`) and a change
// to the cast or the dictionary (`server/cast/ops.ts`) all end by settling the chapter, and the job
// and a retake both queue lines, so each rule is stated here once and the job depends on it rather
// than the other way round.
import type { Job, NarrationScope, NarrationStatus, SegmentAudio } from "@/types";
import { chapterNarration } from "@/lib/runPlan";
import { chapterSeconds, pacingOrDefault } from "@/lib/speech";
import { nextTakeNumber, requeue } from "@/lib/takes";
import type { Tx } from "~/db/client";
import { getBook, setChapterNarration } from "~/db/library";
import { readScript } from "~/db/script";
import type { NarrationCost } from "~/narration/cost";

/** The label a retake job carries as its scope and its `bulk.op`; the Queue page shows it as it is. */
export const RETAKE_LABEL = "Retake";

/**
 * What a run renders: one of the store's scopes, or `pending` — nothing new, only the clips
 * already queued or generating when the run starts. A retake queues its lines when its job is
 * created, so its job runs at `pending` and the handler's in-flight rule does the rest.
 */
export type RunScope = NarrationScope | "pending";

export const inFlight = (status: SegmentAudio["status"]): boolean =>
  status === "queued" || status === "generating";

/** Which clip of its line a render is going to. */
export type Slot = "current" | "candidate";

/**
 * Which slot a line renders into, and the queued clip that holds it meanwhile — the store's rule,
 * kept exactly. A line whose clip has audio gets a candidate beside it, numbered after every take
 * the line has seen, so the chapter keeps playing the old clip until the new one lands; one with
 * nothing worth keeping renders in place. `auto` marks a candidate the run chose to make, which
 * takes over when it lands; a retake a person asked for is not, and waits for their verdict.
 */
export function queuedSlot(
  audio: SegmentAudio,
  { auto }: { auto: boolean },
): { slot: Slot; queued: SegmentAudio } {
  if (audio.duration > 0)
    return {
      slot: "candidate",
      queued: {
        status: "queued",
        endpoint: null,
        ms: 0,
        duration: 0,
        n: nextTakeNumber(audio),
        ...(auto ? { auto: true } : {}),
      },
    };
  return { slot: "current", queued: requeue(audio) };
}

/**
 * Settle a chapter's status and its length from the clips as they now stand, and say what they
 * came to. The status is `chapterNarration`, the same reading the demo makes. The silence between
 * clips is the book's pacing, stitched rather than rendered, and is part of how long the chapter
 * plays even though no provider produced it. A run's last write and a verdict on a retake both
 * end here, so a chapter never has two ways of adding itself up.
 */
export function settleChapter(
  tx: Tx,
  bookId: string,
  chapterId: number,
): { narration: NarrationStatus; seconds: number } {
  const segs = readScript(tx, bookId, chapterId);
  const pacing = pacingOrDefault(getBook(tx, bookId)?.pacing);
  const seconds = chapterSeconds(segs, pacing);
  const narration = chapterNarration(segs);
  setChapterNarration(tx, bookId, chapterId, narration, 100, seconds);
  return { narration, seconds };
}

/** A narration job's run detail: what it holds, how many clips, at which scope, and what it was estimated at. */
export function narrationRunOf(
  cost: NarrationCost,
  clips: number,
  scope: RunScope,
): NonNullable<Job["narrationRun"]> {
  return {
    reserved: cost.reserved,
    clips,
    scope,
    estimated: cost.estimated,
    estimatedInput: cost.estimatedInput,
    estimatedAudio: cost.estimatedAudio,
  };
}
