// A person's operations on one line's narration: ask for a retake, and keep or drop it. A retake
// is queued like a bulk run at the `pending` scope and never `auto`, so it waits beside the clip in
// the book for a verdict. Both settle the chapter, since its length is asked of the clips that play.
import type {
  Book,
  FlaggedRetakes,
  FlaggedRetakesQueued,
  Job,
  Judged,
  RetakesQueued,
  Segment,
} from "@/types";
import { compareReading } from "@/lib/reading";
import { isSpoken } from "@/lib/siteText";
import type { Db, Tx } from "~/db/client";
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
import { bookDelivery, lineReading, narrationCost, type NarrationCost } from "~/narration/cost";
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

/** The lines of `ids` a retake takes; a line with a retake or clip in flight waits its verdict. */
function pickRetakes(segs: readonly Segment[], ids: readonly number[], book: Book | undefined) {
  const queued: Segment[] = [];
  const skipped: RetakesQueued["skipped"] = [];
  for (const id of ids) {
    const s = segs.find((x) => x.id === id);
    if (!s) skipped.push({ id, why: "missing" });
    else if (!isSpoken(s, book)) skipped.push({ id, why: "unspoken" });
    else if (s.candidate || inFlight(s.audio.status)) skipped.push({ id, why: "pending" });
    else queued.push(s);
  }
  return { queued, skipped };
}

/** One chapter's retakes as one job of a run; null when a run slipped in first. */
function enqueueRetakes(
  runner: Runner,
  bookId: string,
  chapterId: number,
  queued: readonly Segment[],
  cost: NarrationCost,
  bulk: { id: number; index: number; total: number },
): Job | null {
  const { job, created } = runner.enqueue({
    kind: "narration",
    bookId,
    chapterId,
    label: RETAKE_LABEL,
    bulk: { ...bulk, op: RETAKE_LABEL, scope: RETAKE_LABEL },
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
  return created ? job : null;
}

const holdRetakes = (db: Db, bookId: string, cost: NarrationCost, what: string) =>
  assertWithinBudget(db, bookId, {
    kind: "narration",
    cost: cost.reserved,
    what,
    requests: cost.firsts,
    request: "the retake's first line",
  });

/**
 * One job of retakes. A chapter with a run in flight is refused, not joined. Held to the book's
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
  const { queued, skipped } = pickRetakes(segs, ids, library.getBook(db, bookId));
  if (!queued.length)
    return { job: null, queued: [], skipped, chapters: library.listChapters(db, bookId) };
  // before anything is written
  const cost = narrationCost(db, bookId, queued);
  holdRetakes(db, bookId, cost, "this retake");
  const job = enqueueRetakes(runner, bookId, chapterId, queued, cost, {
    id: nextRunId(db),
    index: 1,
    total: 1,
  });
  if (!job) throw beingNarrated(db, bookId, chapterId, "ask for the retake");
  return {
    job,
    queued: queued.map((s) => s.id),
    skipped,
    chapters: library.listChapters(db, bookId),
  };
}

/** Each chapter's flagged lines a retake would take; a chapter with a run in flight is `busy`. */
function flaggedPlan(db: Db, bookId: string) {
  requireBook(db, bookId);
  const book = library.getBook(db, bookId);
  const plan: { chapterId: number; queued: Segment[] }[] = [];
  let busy = 0;
  // the counts say where to look, so only chapters with a flag are read
  for (const c of library.listChapters(db, bookId)) {
    if (!c.lines?.flagged) continue;
    if (activeJob(db, "narration", bookId, c.id)) {
      busy++;
      continue;
    }
    const segs = readScript(db, bookId, c.id);
    const flagged = segs.filter((s) => s.flag).map((s) => s.id);
    const { queued } = pickRetakes(segs, flagged, book);
    if (queued.length) plan.push({ chapterId: c.id, queued });
  }
  return { plan, busy };
}

/** What retaking the book's flagged lines would queue, and its price, without queueing it. */
export function flaggedRetakes(db: Db, bookId: string): FlaggedRetakes {
  const { plan, busy } = flaggedPlan(db, bookId);
  const lines = plan.flatMap((p) => p.queued);
  const cost = lines.length ? narrationCost(db, bookId, lines) : null;
  return {
    lines: lines.length,
    chapters: plan.length,
    busy,
    cost: cost && (cost.priced ? cost.estimated : null),
  };
}

/** Every flagged line in the book gets another take: one job a chapter, as one run. */
export function retakeFlagged(db: Db, runner: Runner, bookId: string): FlaggedRetakesQueued {
  const { plan, busy } = flaggedPlan(db, bookId);
  const all = plan.flatMap((p) => p.queued);
  // the whole run before any of it is written
  if (all.length) holdRetakes(db, bookId, narrationCost(db, bookId, all), "these retakes");
  const runId = nextRunId(db);
  const jobs: Job[] = [];
  let lines = 0;
  let late = 0;
  plan.forEach(({ chapterId, queued }, i) => {
    const bulk = { id: runId, index: i + 1, total: plan.length };
    const cost = narrationCost(db, bookId, queued);
    const job = enqueueRetakes(runner, bookId, chapterId, queued, cost, bulk);
    if (!job) return void late++;
    jobs.push(job);
    lines += queued.length;
  });
  return { jobs, lines, busy: busy + late, chapters: library.listChapters(db, bookId) };
}

/**
 * Whichever clip the verdict leaves in the book is checked against the line as it reads now: one
 * rendered before a text, dictionary or voice edit is stale, kept or not.
 */
function markDrift(tx: Tx, bookId: string, chapterId: number, segmentId: number): void {
  const s = readScript(tx, bookId, chapterId).find((x) => x.id === segmentId);
  if (!s || s.audio.status !== "done") return;
  const who = bookDelivery(tx, bookId)(s.speaker);
  if (compareReading(s.audio, s, lineReading(tx, bookId, s, who)).length)
    writeClip(tx, bookId, chapterId, segmentId, "current", { ...s.audio, status: "stale" });
}

/**
 * Kept, the retake becomes the clip in the book (stale if it went stale) and the line's flag is
 * cleared. Dropped, it joins the takes as rejected (or goes, if it never rendered). Refused while
 * rendering, for an accept with no clip, and while a run owns the chapter.
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
  if (
    verdict === "accept" &&
    (!["done", "stale"].includes(candidate.status) || candidate.duration <= 0)
  )
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
    markDrift(tx, bookId, chapterId, segmentId);
    settleChapter(tx, bookId, chapterId);
    return bumpRevision(tx, bookId, chapterId);
  });

  const segment = readScript(db, bookId, chapterId).find((x) => x.id === segmentId);
  const chapter = library.getChapter(db, bookId, chapterId);
  if (!segment || !chapter) throw notFound("The chapter was removed while the take was judged");
  return { segment, revision, chapter };
}
