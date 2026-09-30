// Every read and write a chapter's script makes.
//
// A script is written whole. A scripting run replaces every line of the chapter at once, so the
// write is a delete and an insert in one transaction, and the chapter's `scriptRevision` moves with
// it. That revision is what lets a job that started against one script refuse to overwrite the
// next: it captures the number when it reads the chapter, and the write here only goes through when
// the number has not moved. See `writeScript`.
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";

import type { ChapterLines, RevisedLines, Segment, SegmentAudio, SegmentFlag, Take } from "@/types";
import { snapshotTake } from "@/lib/takes";
import { chapterAt } from "~/db/library";
import { insertRows, prepared } from "~/db/prepared";
import type { Db, Tx } from "~/db/client";
import { chapters, clips, segments } from "~/db/schema";
import { clipValues, segmentClipValues, segmentValues, toSegment, toSegmentAudio } from "~/db/rows";
import { AppError } from "~/lib/errors";

/** SQLite takes its parameters one variable at a time, and a chapter is hundreds of lines. */
const CHUNK = 100;
const chunked = <T>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/** How many lines a chapter's script has; 0 for one never scripted. */
export function lineCount(db: Db | Tx, bookId: string, chapterId: number): number {
  return (
    db
      .select({ n: count() })
      .from(segments)
      .where(and(eq(segments.bookId, bookId), eq(segments.chapterId, chapterId)))
      .get()?.n ?? 0
  );
}

export function readScript(db: Db | Tx, bookId: string, chapterId: number): Segment[] {
  const where = (t: typeof segments | typeof clips) =>
    and(eq(t.bookId, bookId), eq(t.chapterId, chapterId));
  const segRows = db
    .select()
    .from(segments)
    .where(where(segments))
    .orderBy(asc(segments.position))
    .all();
  const clipRows = db.select().from(clips).where(where(clips)).all();
  const bySegment = new Map<number, (typeof clipRows)[number][]>();
  for (const c of clipRows) {
    const list = bySegment.get(c.segmentId) ?? [];
    list.push(c);
    bySegment.set(c.segmentId, list);
  }
  return segRows.map((s) => toSegment(s, bySegment.get(s.id) ?? []));
}

/**
 * The clip a book's row names by this address — whoever's line it is, how long the row says it
 * plays and at what rate — or undefined when no clip row holds it. The demo makes a clip's file
 * from this the first time it is read (`~/audio/demoClips`).
 */
export function clipByUrl(
  db: Db | Tx,
  bookId: string,
  url: string,
): { speaker: string; duration: number; rate: number | null } | undefined {
  return db
    .select({ speaker: segments.speaker, duration: clips.duration, rate: clips.sampleRate })
    .from(clips)
    .innerJoin(
      segments,
      and(
        eq(segments.bookId, clips.bookId),
        eq(segments.chapterId, clips.chapterId),
        eq(segments.id, clips.segmentId),
      ),
    )
    .where(and(eq(clips.bookId, bookId), eq(clips.url, url)))
    .get();
}

/** One chapter, named by placeholders, for the statements a script write repeats per chapter. */
type At = { bookId: string; chapterId: number };
const atBook = sql.placeholder("bookId");
const atChapter = sql.placeholder("chapterId");
/** The keys `replaceScript`'s own statements are kept under (`prepared`). */
const dropScript = Symbol("drop a chapter's script");
const moveRevision = Symbol("move a chapter's revision");

/** How many times this chapter's script has been written, or null when there is no such chapter. */
export function scriptRevision(db: Db | Tx, bookId: string, chapterId: number): number | null {
  const query = prepared(db, scriptRevision, (h) =>
    h
      .select({ revision: chapters.scriptRevision })
      .from(chapters)
      .where(and(eq(chapters.bookId, atBook), eq(chapters.id, atChapter)))
      .prepare(),
  );
  return query.get({ bookId, chapterId } satisfies At)?.revision ?? null;
}

export class ScriptConflict extends Error {
  override readonly name = "ScriptConflict";
  constructor(
    readonly expected: number,
    readonly found: number | null,
  ) {
    super(
      found == null
        ? "The chapter no longer exists, so its script was not written"
        : "The chapter's script changed while this ran, so the result was not written over it",
    );
  }
}

/**
 * Replace a chapter's script inside a transaction the caller already holds, and move its revision.
 *
 * `ifRevision` is the revision the caller read before it started. When it is given and the chapter
 * has moved past it — an edit landed, or a later run wrote first — nothing is written and a
 * `ScriptConflict` says why. That is the rule that keeps a slow job from overwriting newer work,
 * and it holds because the check and the write share the caller's transaction.
 */
export function replaceScript(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segs: readonly Segment[],
  { ifRevision }: { ifRevision?: number } = {},
): { revision: number } {
  const current = scriptRevision(tx, bookId, chapterId);
  if (current == null) throw new ScriptConflict(ifRevision ?? 0, null);
  if (ifRevision != null && current !== ifRevision) throw new ScriptConflict(ifRevision, current);

  // the demo's seed writes some three hundred chapters in one transaction: each of these is
  // compiled once for it, rather than built and compiled again for every chapter
  const at: At = { bookId, chapterId };
  // clips cascade from their segment
  prepared(tx, dropScript, (h) =>
    h
      .delete(segments)
      .where(and(eq(segments.bookId, atBook), eq(segments.chapterId, atChapter)))
      .prepare(),
  ).run(at);
  // a script is hundreds of rows, and a demo seed thousands: one statement each, compiled once
  insertRows(
    tx,
    segments,
    segs.map((s, i) => segmentValues(bookId, chapterId, s, i)),
  );
  insertRows(
    tx,
    clips,
    segs.flatMap((s) => segmentClipValues(bookId, chapterId, s)),
  );

  prepared(tx, moveRevision, (h) =>
    h
      .update(chapters)
      .set({ scriptRevision: sql`${chapters.scriptRevision} + 1` })
      .where(and(eq(chapters.bookId, atBook), eq(chapters.id, atChapter)))
      .prepare(),
  ).run(at);
  return { revision: current + 1 };
}

/** `replaceScript` in a transaction of its own. */
export function writeScript(
  db: Db,
  bookId: string,
  chapterId: number,
  segs: readonly Segment[],
  options: { ifRevision?: number } = {},
): { revision: number } {
  return db.transaction((tx) => replaceScript(tx, bookId, chapterId, segs, options));
}

// ---------- clips, one line at a time ----------
//
// A narration run writes clips as they land, one line at a time, and never the script around them:
// a line's words are the person's and the job's, and its clip is the run's. These write one clip
// row of one line and leave the segment row and the line's other clips where they are.

/** The rows of one line's clip in one role: at most one, since the index only allows takes to repeat. */
function roleWhere(
  bookId: string,
  chapterId: number,
  segmentId: number,
  role: "current" | "candidate",
) {
  return and(
    eq(clips.bookId, bookId),
    eq(clips.chapterId, chapterId),
    eq(clips.segmentId, segmentId),
    eq(clips.role, role),
  );
}

/** A line that an edit removed while a clip was rendering for it. The chapter is still there. */
export class LineGone extends AppError {
  constructor(segmentId: number) {
    super(404, `Line ${segmentId} is no longer in the script`);
  }
}

function requireSegment(tx: Tx, bookId: string, chapterId: number, segmentId: number): void {
  const found = tx
    .select({ id: segments.id })
    .from(segments)
    .where(
      and(
        eq(segments.bookId, bookId),
        eq(segments.chapterId, chapterId),
        eq(segments.id, segmentId),
      ),
    )
    .get();
  if (!found) throw new LineGone(segmentId);
}

/**
 * Put `clip` in one line's `current` or `candidate` slot, replacing whatever was there.
 *
 * The line's takes are untouched: a take is history, and a clip landing is not what changes it.
 * A line that has gone from the script is refused, so a result for a line an edit removed while
 * it rendered is never written against nothing.
 */
export function writeClip(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
  role: "current" | "candidate",
  clip: SegmentAudio,
): void {
  requireSegment(tx, bookId, chapterId, segmentId);
  tx.delete(clips)
    .where(roleWhere(bookId, chapterId, segmentId, role))
    .run();
  // `takes` on the clip are the line's take rows, not columns of this row
  const { takes: _takes, ...own } = clip;
  tx.insert(clips)
    .values(clipValues(bookId, chapterId, segmentId, role, own))
    .run();
}

/** Add one superseded clip to a line's take list. */
export function addTake(tx: Tx, bookId: string, chapterId: number, segmentId: number, take: Take) {
  requireSegment(tx, bookId, chapterId, segmentId);
  tx.insert(clips)
    .values(clipValues(bookId, chapterId, segmentId, "take", take))
    .run();
}

/** Drop a line's retake, whatever state it is in. Says whether there was one. */
export function dropCandidate(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
): boolean {
  return (
    tx
      .delete(clips)
      .where(roleWhere(bookId, chapterId, segmentId, "candidate"))
      .returning({ id: clips.id })
      .all().length > 0
  );
}

/**
 * Freeze a clip as a take. `snapshotTake` is the store's rule for what a take keeps; the file is
 * added back because the store never had one and a take that cannot be played is not a take.
 */
export function takeOf(a: SegmentAudio): Take {
  return { ...snapshotTake(a), ...(a.url ? { url: a.url } : {}) };
}

/**
 * Turn a line's retake down, and say what became of it.
 *
 * A retake that rendered joins the take list marked rejected, so the comparison the listener made
 * is still playable afterwards and its number is never handed out again; one that never produced
 * a clip — failed, or dropped before it rendered — has nothing worth keeping and simply goes. The
 * clip in the book is not touched: it was never displaced, so there is nothing to put back. The
 * same rule applies to a retake in the way of a run (`queueRender` in `~/jobs/narration`).
 */
export function rejectCandidate(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
): Take | null {
  const row = tx
    .select()
    .from(clips)
    .where(roleWhere(bookId, chapterId, segmentId, "candidate"))
    .get();
  if (!row) return null;
  tx.delete(clips).where(eq(clips.id, row.id)).run();
  if (row.duration <= 0) return null;
  const take: Take = { ...takeOf(toSegmentAudio(row)), rejected: true };
  addTake(tx, bookId, chapterId, segmentId, take);
  return take;
}

/**
 * A replacement that succeeded takes over: the retake becomes the clip in the book and the one it
 * displaces joins the take list, so the history is kept and nobody is asked for 300 verdicts, and
 * a retake the listener kept does the same: the candidate row becomes the current row with `auto`
 * stripped, and the takes are left as they are, one more if the old clip had audio.
 */
export function acceptCandidate(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
): void {
  const rows = tx
    .select()
    .from(clips)
    .where(
      and(eq(clips.bookId, bookId), eq(clips.chapterId, chapterId), eq(clips.segmentId, segmentId)),
    )
    .all();
  const candidate = rows.find((r) => r.role === "candidate");
  if (!candidate || candidate.duration <= 0) return;
  const current = rows.find((r) => r.role === "current");
  if (current) {
    tx.delete(clips).where(eq(clips.id, current.id)).run();
    if (current.duration > 0)
      addTake(tx, bookId, chapterId, segmentId, takeOf(toSegmentAudio(current)));
  }
  tx.update(clips).set({ role: "current", auto: null }).where(eq(clips.id, candidate.id)).run();
}

/**
 * Take the listener's complaint off a line. A kept retake answers it; a line whose new take was
 * chosen over the one that was flagged is no longer a line with a problem.
 */
export function clearFlag(tx: Tx, bookId: string, chapterId: number, segmentId: number): void {
  setFlag(tx, bookId, chapterId, segmentId, null);
}

/** Write one line's flag, or take it down with `null`; false when the line is not in the script. */
export function setFlag(
  tx: Db | Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
  flag: SegmentFlag | null,
): boolean {
  return !!tx
    .update(segments)
    .set({ flag })
    .where(
      and(
        eq(segments.bookId, bookId),
        eq(segments.chapterId, chapterId),
        eq(segments.id, segmentId),
      ),
    )
    .returning({ id: segments.id })
    .get();
}

/**
 * Move a chapter's script revision on by one, and say where it is now.
 *
 * The revision counts every write of a chapter's script rows, whoever made it — a scripting run,
 * an edit, a rename that moved lines, and a clip that landed. A clip is part of the script a client
 * reads and writes back whole, so a client editing from a copy read before a clip landed would
 * write the clip's old state over the new one; moving the revision here means that edit is refused
 * with the 409 it already handles, and the client reads the chapter again with the clip in it.
 * Every transaction that writes clips for a chapter calls this once, whatever it wrote.
 */
export function bumpRevision(tx: Tx, bookId: string, chapterId: number): number {
  const revision = tx
    .update(chapters)
    .set({ scriptRevision: sql`${chapters.scriptRevision} + 1` })
    .where(chapterAt(bookId, chapterId))
    .returning({ revision: chapters.scriptRevision })
    .get()?.revision;
  if (revision == null) throw new ScriptConflict(0, null);
  return revision;
}

// ---------- lines by speaker ----------

/**
 * Give every line of the book that `from` reads to `to`, and say which lines moved.
 *
 * A rename or a merge on the Cast page. The lines moved are returned by chapter so an Undo can put
 * exactly those back (`attributeLines`), rather than moving every line `to` now has. Each chapter
 * touched has its script revision moved on — a scripting job in flight against it must not land
 * on top of the change — and a clip rendered for a line that now names a different speaker no
 * longer matches its line, so it is marked stale, as the cast store does.
 */
export function reattribute(tx: Tx, bookId: string, from: string, to: string): RevisedLines[] {
  const rows = tx
    .select({ chapterId: segments.chapterId, id: segments.id })
    .from(segments)
    .where(and(eq(segments.bookId, bookId), eq(segments.speaker, from)))
    .orderBy(asc(segments.chapterId), asc(segments.position))
    .all();
  const byChapter = new Map<number, number[]>();
  for (const r of rows) byChapter.set(r.chapterId, [...(byChapter.get(r.chapterId) ?? []), r.id]);
  const moved = [...byChapter].map(([chapterId, ids]) => ({ chapterId, ids }));
  return attributeLines(tx, bookId, moved, to);
}

/**
 * Put `speaker` on exactly these lines: the primitive under a rename, a merge and their undo.
 * Lines that no longer exist are left out of the count rather than refused, because an undo of a
 * batch is a person's intent for the rest.
 */
export function attributeLines(
  tx: Tx,
  bookId: string,
  lines: readonly ChapterLines[],
  speaker: string,
): RevisedLines[] {
  const moved: RevisedLines[] = [];
  for (const { chapterId, ids } of lines) {
    let changed = 0;
    for (const part of chunked(ids)) {
      const where = and(
        eq(segments.bookId, bookId),
        eq(segments.chapterId, chapterId),
        inArray(segments.id, part),
      );
      const n = tx
        .update(segments)
        .set({ speaker })
        .where(where)
        .returning({ id: segments.id })
        .all().length;
      if (!n) continue;
      changed += n;
      tx.update(clips)
        .set({ status: "stale" })
        .where(
          and(
            eq(clips.bookId, bookId),
            eq(clips.chapterId, chapterId),
            inArray(clips.segmentId, part),
            eq(clips.role, "current"),
            eq(clips.status, "done"),
          ),
        )
        .run();
    }
    if (!changed) continue;
    const revision = tx
      .update(chapters)
      .set({ scriptRevision: sql`${chapters.scriptRevision} + 1` })
      .where(chapterAt(bookId, chapterId))
      .returning({ revision: chapters.scriptRevision })
      .get()?.revision;
    if (revision != null) moved.push({ chapterId, ids, revision });
  }
  return moved;
}

/**
 * The clips each speech endpoint has rendered that the library plays, done and failed, by
 * endpoint id: what the Queue's endpoint pool counts, across every book rather than the chapters a
 * page happens to have read. A retake waiting for its verdict and a superseded take are not the
 * book's clips, so only the current one of each line counts.
 */
export function clipsByEndpoint(db: Db | Tx): Map<string, { done: number; failed: number }> {
  const rows = db
    .select({
      endpoint: clips.endpoint,
      done: sql<number>`sum(case when ${clips.status} = 'done' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${clips.status} = 'failed' then 1 else 0 end)`,
    })
    .from(clips)
    .where(and(eq(clips.role, "current"), sql`${clips.endpoint} is not null`))
    .groupBy(clips.endpoint)
    .all();
  return new Map(
    rows.map((r) => [r.endpoint!, { done: Number(r.done), failed: Number(r.failed) }]),
  );
}
