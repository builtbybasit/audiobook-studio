// What a person does to one line's narration, as operations: ask for another take of it, and say
// which take they are keeping.
//
// A retake is the demo's comparison — a new clip rendered beside the one in the book, for the
// listener to judge — put through the same queue as a bulk run. The request writes the lines'
// queued clips in the transaction that creates the job, so the chapter reads as a run in progress
// from the moment the route answers, and the job runs at the scope that wants nothing new
// (`RunScope`'s `pending`), so the handler renders exactly the clips this request queued and marks
// none of them `auto`: a retake that lands waits, where a bulk replacement takes over. The verdict
// is the other half. Both end by settling the chapter the way a run does, because a kept take is a
// clip that plays and a chapter's length is asked of the clips that play.
import type { Chapter, Job, Segment } from "@/types";
import { nextTakeNumber, requeue } from "@/lib/takes";
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
import { inFlight, RETAKE_LABEL, setChapterNarration, settleChapter } from "~/jobs/narration";
import type { Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";

export interface RetakesQueued {
  /** the job, or null when nothing was queued */
  job: Job | null;
  queued: number[];
  skipped: { id: number; why: "missing" | "pending" }[];
}

export interface Judged {
  /** the line as it now stands */
  segment: Segment;
  revision: number;
  /** the chapter as it now stands: status and duration follow the clip that plays */
  chapter: Chapter;
}

export type Verdict = "accept" | "reject";

/** The chapter and its script, or the refusal that says which of them there is not. */
function requireScripted(db: Db, bookId: string, chapterId: number, what: string) {
  requireBook(db, bookId);
  const chapter = library.getChapter(db, bookId, chapterId);
  if (!chapter) throw notFound("No such chapter");
  const segs = readScript(db, bookId, chapterId);
  if (!segs.length) throw notFound(`This chapter has no script to ${what}`);
  return { chapter, segs };
}

const beingNarrated = (chapterId: number, then: string) =>
  conflict(`Chapter ${chapterId} is being narrated`, `Wait for the run to finish, then ${then}.`);

/**
 * Render another take of these lines, as one job.
 *
 * The store's `_queueRetake` and `_resume`, on rows. A line that already has a retake — waiting for
 * a verdict, or still rendering — or whose own clip is in flight is left out and said so, because
 * one comparison at a time is what a verdict is a verdict on; a line not in the script is said so
 * too. A line with a playable clip gets its retake beside it, numbered after every take the line
 * has seen; one with nothing worth keeping renders in place, which is a plain re-render and not a
 * comparison. Nothing is written when nothing is queued. A chapter with a run in flight is refused
 * rather than joined, as the demo's `_resume` returns early while the chapter is running, and the
 * queue's one-job-per-chapter rule would hand back that run's job in any case.
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
    throw beingNarrated(chapterId, "ask for the retake");

  const queued: Segment[] = [];
  const skipped: RetakesQueued["skipped"] = [];
  for (const id of ids) {
    const s = segs.find((x) => x.id === id);
    if (!s) skipped.push({ id, why: "missing" });
    else if (s.candidate || inFlight(s.audio.status)) skipped.push({ id, why: "pending" });
    else queued.push(s);
  }
  if (!queued.length) return { job: null, queued: [], skipped };

  const { job, created } = runner.enqueue({
    kind: "narration",
    bookId,
    chapterId,
    label: `${RETAKE_LABEL} · ch ${chapterId}`,
    bulk: { id: nextRunId(db), op: RETAKE_LABEL, index: 1, total: 1, scope: RETAKE_LABEL },
    // the fake costs nothing to reserve; a real provider's price is the server's to meter
    run: { narrationRun: { reserved: 0, clips: queued.length } },
    // in the same transaction as the row, so the lines hold their slots before the run can start
    // and the chapter cannot read as queued after the worker has moved on
    onCreated: (tx) => {
      for (const s of queued) {
        if (s.audio.duration > 0)
          writeClip(tx, bookId, chapterId, s.id, "candidate", {
            status: "queued",
            endpoint: null,
            ms: 0,
            duration: 0,
            n: nextTakeNumber(s.audio),
          });
        else writeClip(tx, bookId, chapterId, s.id, "current", requeue(s.audio));
      }
      setChapterNarration(tx, bookId, chapterId, "queued", 0);
      bumpRevision(tx, bookId, chapterId);
    },
  });
  // the check above and the enqueue are not one transaction; a run that slipped in between is the
  // job handed back, and it was not this request's, so the lines were not queued
  if (!created) throw beingNarrated(chapterId, "ask for the retake");
  return { job, queued: queued.map((s) => s.id), skipped };
}

/**
 * Keep or drop a line's retake.
 *
 * The store's `acceptTake` and `rejectTake`, on rows and in one transaction. Kept, the retake
 * becomes the clip in the book with the takes it displaces behind it, and the listener's complaint
 * comes off the line — the retake answered it. Dropped, the retake joins the take list marked
 * rejected if it rendered and simply goes if it did not, and the clip in the book is left exactly
 * as it was; whether that clip has drifted from its line since is the browser's reading to make,
 * as it is in the demo. Either way the chapter is settled from the clips that now play, and the
 * revision moves, since the script a client holds has a clip in it that is no longer there.
 *
 * A retake still rendering has nothing to judge yet, and one that never produced a clip cannot be
 * kept; both are refused, so a verdict is only ever on a comparison that can be heard. A chapter
 * with a run in flight is refused too: its status is the run's to write until the run ends.
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
    throw beingNarrated(chapterId, "give the verdict");

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
