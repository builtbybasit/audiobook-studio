// Every read and write a chapter's script makes.
//
// A script is written whole. A scripting run replaces every line of the chapter at once, so the
// write is a delete and an insert in one transaction, and the chapter's `scriptRevision` moves with
// it. That revision is what lets a job that started against one script refuse to overwrite the
// next: it captures the number when it reads the chapter, and the write here only goes through when
// the number has not moved. See `writeScript`.
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Segment } from "@/types";
import type { Db, Tx } from "~/db/client";
import { chapters, clips, segments } from "~/db/schema";
import { segmentClipValues, segmentValues, toSegment } from "~/db/rows";

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
