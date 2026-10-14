// A person's operations on one line's narration: ask for a retake, and keep or drop it. A retake
// is queued like a bulk run at the `pending` scope and never `auto`, so it waits beside the clip in
// the book for a verdict. Both settle the chapter, since its length is asked of the clips that play.
import type { Judged, RetakesQueued, Segment } from "@/types";
import { isSpoken } from "@/lib/siteText";
import type { Db } from "~/db/client";
import { activeJob, nextRunId } from "~/db/jobs";
import * as library from "~/db/library";
import {
  acceptCandidate,
  bumpRevision,
  clearFlag,
  readScript,
  rejectCandidate,
  writeClip,
} from "~/db/script";
import type { Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";
import {
  inFlight,
  narrationRunOf,
  queuedSlot,
  RETAKE_LABEL,
  settleChapter,
} from "~/narration/chapter";
import { narrationCost } from "~/narration/cost";
import { assertWithinBudget } from "~/usage/budget";

export type Verdict = "accept" | "reject";

function requireScripted(db: Db, bookId: string, chapterId: number, what: string) {
  requireBook(db, bookId);
  const chapter = library.getChapter(db, bookId, chapterId);
  if (!chapter) throw notFound("No such chapter");
  const segs = readScript(db, bookId, chapterId);
  if (!segs.length) throw notFound(`This chapter has no script to ${what}`);
  return { chapter, segs };
}

/** Names the chapter by its reading number, never its id. */
function beingNarrated(db: Db, bookId: string, chapterId: number, then: string) {
  const name = library.chapterName(db, bookId, chapterId);
  return conflict(
    `${name[0].toUpperCase()}${name.slice(1)} is being narrated`,
    `Wait for the run to finish, then ${then}.`,
  );
}

/**
 * One job of retakes. A line with a retake or clip already in flight is skipped: a verdict is on one
 * comparison at a time. A chapter with a run in flight is refused, not joined. Held to the book's
 * budget like a bulk run. See `queuedSlot` for where each take lands.
 */
export function retakeLines(
  db: Db,
  runner: Runner,
  bookId: string,
  chapterId: number,
  ids: readonly number[],
): RetakesQueued {
  const { segs } = requireScripted(db, bookId, chapterId, "retake");
  if (activeJob(db, "narration", bookId, chapterId))
    throw beingNarrated(db, bookId, chapterId, "ask for the retake");
  const book = library.getBook(db, bookId);

  const queued: Segment[] = [];
  const skipped: RetakesQueued["skipped"] = [];
  for (const id of ids) {
    const s = segs.find((x) => x.id === id);
    if (!s) skipped.push({ id, why: "missing" });
    else if (!isSpoken(s, book)) skipped.push({ id, why: "unspoken" });
    else if (s.candidate || inFlight(s.audio.status)) skipped.push({ id, why: "pending" });
    else queued.push(s);
  }
  if (!queued.length)
    return { job: null, queued: [], skipped, chapters: library.listChapters(db, bookId) };
  // before anything is written
  const cost = narrationCost(db, bookId, queued);
  assertWithinBudget(db, bookId, {
    kind: "narration",
    cost: cost.reserved,
    what: "this retake",
    requests: cost.firsts,
    request: "the retake's first line",
  });

  const { job, created } = runner.enqueue({
    kind: "narration",
    bookId,
    chapterId,
    label: RETAKE_LABEL,
    bulk: { id: nextRunId(db), op: RETAKE_LABEL, index: 1, total: 1, scope: RETAKE_LABEL },
    run: { narrationRun: narrationRunOf(cost, queued.length, "pending") },
    // with the job row, so the slots are held before the run can start
    onCreated: (tx) => {
      for (const s of queued) {
        const { slot, queued: clip } = queuedSlot(s.audio, { auto: false });
        writeClip(tx, bookId, chapterId, s.id, slot, clip);
      }
      library.setChapterNarration(tx, bookId, chapterId, "queued", 0);
      bumpRevision(tx, bookId, chapterId);
    },
  });
  // a run that slipped in between the check and the enqueue was handed back instead
  if (!created) throw beingNarrated(db, bookId, chapterId, "ask for the retake");
  return {
    job,
    queued: queued.map((s) => s.id),
    skipped,
    chapters: library.listChapters(db, bookId),
  };
}

/**
 * Kept, the retake becomes the clip in the book and the line's flag is cleared. Dropped, it joins
 * the takes as rejected (or goes, if it never rendered). Refused while rendering, for an accept with
 * no clip, and while a run owns the chapter.
 */
export function judgeTake(
  db: Db,
  bookId: string,
  chapterId: number,
  segmentId: number,
  verdict: Verdict,
): Judged {
  const { segs } = requireScripted(db, bookId, chapterId, "judge");
  const s = segs.find((x) => x.id === segmentId);
  if (!s) throw notFound(`Line ${segmentId} is not in this chapter's script`);
  const candidate = s.candidate;
  if (!candidate) throw conflict("Nothing to judge: this line has no retake");
  if (inFlight(candidate.status)) throw conflict("The retake is still rendering");
  if (verdict === "accept" && (candidate.status !== "done" || candidate.duration <= 0))
    throw conflict("The retake did not produce a clip; discard it instead");
  if (activeJob(db, "narration", bookId, chapterId))
    throw beingNarrated(db, bookId, chapterId, "give the verdict");

  const revision = db.transaction((tx) => {
    if (verdict === "accept") {
      acceptCandidate(tx, bookId, chapterId, segmentId);
      clearFlag(tx, bookId, chapterId, segmentId);
    } else {
      rejectCandidate(tx, bookId, chapterId, segmentId);
    }
    settleChapter(tx, bookId, chapterId);
    return bumpRevision(tx, bookId, chapterId);
  });

  const segment = readScript(db, bookId, chapterId).find((x) => x.id === segmentId);
  const chapter = library.getChapter(db, bookId, chapterId);
  if (!segment || !chapter) throw notFound("The chapter was removed while the take was judged");
  return { segment, revision, chapter };
}
