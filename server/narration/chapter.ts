// The narration rules shared by the job, retakes (`ops.ts`) and cast changes (`server/cast/ops.ts`):
// which slot a line renders into, what is in flight, and how a chapter adds itself up.
import type { Job, NarrationScope, NarrationStatus, SegmentAudio } from "@/types";
import { chapterNarration } from "@/lib/runPlan";
import { chapterSeconds, pacingOrDefault } from "@/lib/speech";
import { nextTakeNumber, requeue } from "@/lib/takes";
import type { Tx } from "~/db/client";
import { getBook, getChapter, setChapterNarration } from "~/db/library";
import { readScript } from "~/db/script";
import type { NarrationCost } from "~/narration/cost";

/** A retake job's scope and `bulk.op`, shown as is on the Queue page. */
export const RETAKE_LABEL = "Retake";

/** `pending` renders only the clips already in flight when the run starts (a retake's). */
export type RunScope = NarrationScope | "pending";

export const inFlight = (status: SegmentAudio["status"]): boolean =>
  status === "queued" || status === "generating";

export type Slot = "current" | "candidate";

/**
 * The store's rule, kept exactly. A line with audio gets a candidate beside it, so the old clip
 * plays until the new one lands; otherwise it renders in place. An `auto` candidate takes over when
 * it lands; a retake (not `auto`) waits for a verdict.
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
 * Status and length from the clips as they now stand; the length includes the pacing silence
 * between clips. The one way a chapter adds itself up.
 */
export function settleChapter(
  tx: Tx,
  bookId: string,
  chapterId: number,
): { narration: NarrationStatus; seconds: number } {
  const segs = readScript(tx, bookId, chapterId);
  const book = getBook(tx, bookId);
  const seconds = chapterSeconds(segs, pacingOrDefault(book?.pacing), book);
  const narration = chapterNarration(segs, book);
  setChapterNarration(tx, bookId, chapterId, narration, 100, seconds);
  return { narration, seconds };
}

/** While a job holds the chapter, its status is the run's to add up. */
export function narrationInProgress(tx: Tx, bookId: string, chapterId: number): boolean {
  const narration = getChapter(tx, bookId, chapterId)?.narration;
  return narration === "queued" || narration === "running";
}

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
