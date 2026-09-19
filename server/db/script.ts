// Every read and write a chapter's script makes.
//
// A script is written whole. A scripting run replaces every line of the chapter at once, so the
// write is a delete and an insert in one transaction, and the chapter's `scriptRevision` moves with
// it. That revision is what lets a job that started against one script refuse to overwrite the
// next: it captures the number when it reads the chapter, and the write here only goes through when
// the number has not moved. See `writeScript`.
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Segment, SegmentAudio, Take } from "@/types";
import { snapshotTake } from "@/lib/takes";
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

/** How many times this chapter's script has been written, or null when there is no such chapter. */
export function scriptRevision(db: Db | Tx, bookId: string, chapterId: number): number | null {
  return (
    db
      .select({ revision: chapters.scriptRevision })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
      .get()?.revision ?? null
  );
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

  const where = and(eq(segments.bookId, bookId), eq(segments.chapterId, chapterId));
  // clips cascade from their segment
  tx.delete(segments).where(where).run();
  for (const part of chunked(segs.map((s, i) => segmentValues(bookId, chapterId, s, i))))
    tx.insert(segments).values(part).run();
  const clipRows = segs.flatMap((s) => segmentClipValues(bookId, chapterId, s));
  for (const part of chunked(clipRows)) tx.insert(clips).values(part).run();

  tx.update(chapters)
    .set({ scriptRevision: sql`${chapters.scriptRevision} + 1` })
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .run();
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
 * A bulk replacement that succeeded takes over: the retake becomes the clip in the book and the one
 * it displaces joins the take list, so the history is kept and nobody is asked for 300 verdicts.
 * The store's `_acceptReplacement`, on rows: the candidate row becomes the current row with
 * `auto` stripped, and the takes are left as they are, one more if the old clip had audio.
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
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .returning({ revision: chapters.scriptRevision })
    .get()?.revision;
  if (revision == null) throw new ScriptConflict(0, null);
  return revision;
}

// ---------- lines by speaker ----------

/** Lines of one chapter, named by number. */
export interface ChapterLines {
  chapterId: number;
  ids: number[];
}

/** Lines that changed hands, and the revision their chapter is at now that they have. */
export interface MovedLines extends ChapterLines {
  revision: number;
}

/**
 * Give every line of the book that `from` reads to `to`, and say which lines moved.
 *
 * A rename or a merge on the Cast page. The lines moved are returned by chapter so an Undo can put
 * exactly those back (`attributeLines`), rather than moving every line `to` now has. Each chapter
 * touched has its script revision moved on — a scripting job in flight against it must not land
 * on top of the change — and a clip rendered for a line that now names a different speaker no
 * longer matches its line, so it is marked stale, as the cast store does.
 */
export function reattribute(tx: Tx, bookId: string, from: string, to: string): MovedLines[] {
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
): MovedLines[] {
  const moved: MovedLines[] = [];
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
      .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
      .returning({ revision: chapters.scriptRevision })
      .get()?.revision;
    if (revision != null) moved.push({ chapterId, ids, revision });
  }
  return moved;
}
