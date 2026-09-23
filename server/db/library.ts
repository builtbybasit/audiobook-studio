// Every read and write the library makes.
//
// The routes call these and nothing else: no route builds a query, and no query knows it is being
// served over HTTP. An import writes a book, its volume, its chapters and their text in one
// transaction, so a crash halfway through a nine-hundred-chapter file leaves no half-imported book
// behind for the review to choke on.
import { and, asc, count, eq, inArray, max, sql } from "drizzle-orm";

import type { Book, Chapter, ChapterCounts, Volume } from "@/types";
import type { Db, Tx } from "~/db/client";
import type { ChapterBody } from "~/import/assemble";
import { rekeyActive } from "~/db/jobs";
import {
  books,
  chapters,
  chapterTexts,
  clips,
  exportChapters,
  exportFiles,
  exportItems,
  volumes,
} from "~/db/schema";
import { bookValues, chapterValues, toBook, toChapter, volumeValues } from "~/db/rows";

/** SQLite takes its parameters one variable at a time, and a long web novel is thousands of rows. */
const CHUNK = 200;
const chunked = <T>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/**
 * How each book's chapters stand, counted in one pass.
 *
 * The shelf lists books without their chapters — a review's worth of rows per book is not a cheap
 * listing — and these are what let a card say "12 chapters, 3 scripted" before the book has been
 * opened. One query over the table, grouped, rather than one per book.
 */
export function chapterCounts(db: Db | Tx, bookId?: string): Map<string, ChapterCounts> {
  const rows = db
    .select({
      bookId: chapters.bookId,
      total: count(),
      included: sql<number>`sum(case when ${chapters.excluded} then 0 else 1 end)`,
      scripted: sql<number>`sum(case when ${chapters.scripting} in ('done', 'fallback') then 1 else 0 end)`,
      narrated: sql<number>`sum(case when ${chapters.narration} in ('done', 'stale') then 1 else 0 end)`,
    })
    .from(chapters)
    .where(bookId ? eq(chapters.bookId, bookId) : undefined)
    .groupBy(chapters.bookId)
    .all();
  return new Map(
    rows.map((r) => [
      r.bookId,
      {
        total: r.total,
        included: Number(r.included),
        scripted: Number(r.scripted),
        narrated: Number(r.narrated),
      },
    ]),
  );
}

const NO_CHAPTERS: ChapterCounts = { total: 0, included: 0, scripted: 0, narrated: 0 };

export function listBooks(db: Db): Book[] {
  const rows = db.select().from(books).orderBy(asc(books.addedAt), asc(books.id)).all();
  const vols = db.select().from(volumes).orderBy(asc(volumes.position)).all();
  const counts = chapterCounts(db);
  return rows.map((b) =>
    toBook(
      b,
      vols.filter((v) => v.bookId === b.id),
      counts.get(b.id) ?? NO_CHAPTERS,
    ),
  );
}

export function getBook(db: Db | Tx, id: string): Book | undefined {
  const row = db.select().from(books).where(eq(books.id, id)).get();
  if (!row) return undefined;
  const vols = db
    .select()
    .from(volumes)
    .where(eq(volumes.bookId, id))
    .orderBy(asc(volumes.position))
    .all();
  return toBook(row, vols, chapterCounts(db, id).get(id) ?? NO_CHAPTERS);
}

export function listChapters(db: Db | Tx, bookId: string): Chapter[] {
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.id))
    .all()
    .map(toChapter);
}

export function getChapter(db: Db | Tx, bookId: string, id: number): Chapter | undefined {
  const row = db
    .select()
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, id)))
    .get();
  return row ? toChapter(row) : undefined;
}

export function getChapterBody(db: Db, bookId: string, chapterId: number): string | undefined {
  return db
    .select({ body: chapterTexts.body })
    .from(chapterTexts)
    .where(and(eq(chapterTexts.bookId, bookId), eq(chapterTexts.chapterId, chapterId)))
    .get()?.body;
}

/** An id nobody is using: `moonlight-ledger`, then `-2`, `-3`, … */
export function freeBookId(db: Db, base: string): string {
  const taken = new Set(
    db
      .select({ id: books.id })
      .from(books)
      .all()
      .map((r) => r.id),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Write a whole imported book. All of it, or none of it. */
export function insertBook(
  db: Db,
  book: Book,
  chs: readonly Chapter[],
  bodies: readonly ChapterBody[],
  addedAt = Date.now(),
): void {
  db.transaction((tx) => {
    tx.insert(books).values(bookValues(book, addedAt)).run();
    book.volumes.forEach((v, i) =>
      tx
        .insert(volumes)
        .values(volumeValues(book.id, v, i))
        .run(),
    );
    for (const part of chunked(chs))
      tx.insert(chapters)
        .values(part.map((c) => chapterValues(book.id, c)))
        .run();
    for (const part of chunked(bodies))
      tx.insert(chapterTexts)
        .values(part.map((b) => ({ bookId: book.id, chapterId: b.chapterId, body: b.body })))
        .run();
  });
}

/** Add one more volume to a book that is already in the library. */
export function insertVolume(
  db: Db,
  bookId: string,
  volume: Volume,
  chs: readonly Chapter[],
  bodies: readonly ChapterBody[],
): void {
  db.transaction((tx) => {
    const position =
      (tx
        .select({ n: max(volumes.position) })
        .from(volumes)
        .where(eq(volumes.bookId, bookId))
        .get()?.n ?? -1) + 1;
    tx.insert(volumes)
      .values(volumeValues(bookId, volume, position))
      .run();
    for (const part of chunked(chs))
      tx.insert(chapters)
        .values(part.map((c) => chapterValues(bookId, c)))
        .run();
    for (const part of chunked(bodies))
      tx.insert(chapterTexts)
        .values(part.map((b) => ({ bookId, chapterId: b.chapterId, body: b.body })))
        .run();
  });
}

/** The highest chapter number in a book, or 0 when it has none. */
export function lastChapterNumber(db: Db, bookId: string): number {
  return (
    db
      .select({ n: max(chapters.id) })
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .get()?.n ?? 0
  );
}

/** The highest volume id in a book, or 0. */
export function lastVolumeId(db: Db, bookId: string): number {
  return (
    db
      .select({ n: max(volumes.id) })
      .from(volumes)
      .where(eq(volumes.bookId, bookId))
      .get()?.n ?? 0
  );
}

/**
 * Skip chapters for the audiobook, or include them again.
 *
 * Nothing is deleted: a skipped chapter keeps its text, its number and its place. Including a
 * chapter that carries a note counts as having looked at it, so the suggestion stops asking —
 * the same rule `libraryStore.skipChapters` applies in the demo.
 */
export function setSkipped(db: Db, bookId: string, ids: readonly number[], skip: boolean): number {
  if (!ids.length) return 0;
  let changed = 0;
  db.transaction((tx) => {
    for (const part of chunked(ids)) {
      const rows = tx
        .select()
        .from(chapters)
        .where(and(eq(chapters.bookId, bookId), inArray(chapters.id, part)))
        .all();
      for (const row of rows) {
        if (!!row.excluded === skip) continue;
        tx.update(chapters)
          .set(skip ? { excluded: true } : { excluded: null, ...(row.note ? { kept: true } : {}) })
          .where(and(eq(chapters.bookId, bookId), eq(chapters.id, row.id)))
          .run();
        changed++;
      }
    }
  });
  return changed;
}

/** The user read a note and is keeping the chapter: it stays in, and the suggestion stops asking. */
export function setKept(db: Db, bookId: string, ids: readonly number[]): number {
  if (!ids.length) return 0;
  let changed = 0;
  db.transaction((tx) => {
    for (const part of chunked(ids)) {
      const rows = tx
        .select()
        .from(chapters)
        .where(and(eq(chapters.bookId, bookId), inArray(chapters.id, part)))
        .all();
      for (const row of rows) {
        if (!row.note || (row.kept && !row.excluded)) continue;
        tx.update(chapters)
          .set({ excluded: null, kept: true })
          .where(and(eq(chapters.bookId, bookId), eq(chapters.id, row.id)))
          .run();
        changed++;
      }
    }
  });
  return changed;
}

/** One chapter's review decisions, stated outright: skipped or not, looked at or not. */
export interface ReviewDecision {
  id: number;
  excluded?: boolean;
  kept?: boolean;
}

/**
 * Put chapters' review decisions to exactly these, whatever they are now.
 *
 * The undo primitive. `setSkipped` and `setKept` each apply a rule — including a noted chapter
 * counts as having looked at it — and a rule cannot be run backwards: an undone skip would come
 * back as `kept` rather than as the undecided chapter it was. So an Undo records what the chapters
 * were and puts that back, exactly, through this. A chapter not in the book is left out of the
 * count rather than refused, because an undo of a batch is a person's intent for the rest.
 */
export function setDecisions(db: Db, bookId: string, decisions: readonly ReviewDecision[]): number {
  if (!decisions.length) return 0;
  let changed = 0;
  db.transaction((tx) => {
    for (const part of chunked(decisions)) {
      const rows = tx
        .select()
        .from(chapters)
        .where(
          and(
            eq(chapters.bookId, bookId),
            inArray(
              chapters.id,
              part.map((d) => d.id),
            ),
          ),
        )
        .all();
      for (const d of part) {
        const row = rows.find((r) => r.id === d.id);
        if (!row) continue;
        const excluded = d.excluded ? true : null;
        // `kept` means nothing on a chapter with no note, and is never written to one
        const kept = d.kept && row.note ? true : null;
        if (!!row.excluded === !!excluded && !!row.kept === !!kept) continue;
        tx.update(chapters)
          .set({ excluded, kept })
          .where(and(eq(chapters.bookId, bookId), eq(chapters.id, d.id)))
          .run();
        changed++;
      }
    }
  });
  return changed;
}

/** The review is done: the book, or its new volume, is in the library. */
export function confirmImport(db: Db, bookId: string): void {
  db.transaction((tx) => {
    tx.update(books).set({ importing: false }).where(eq(books.id, bookId)).run();
    tx.update(volumes).set({ importing: false }).where(eq(volumes.bookId, bookId)).run();
  });
}

/**
 * Give a book's chapters the numbers 1..n in reading order, and put the volume ranges back.
 *
 * Chapter numbers are continuous across volumes and are the key everything downstream uses — the
 * script, the clips, the history, an export's chapter list — so a removal that left a gap, or left
 * `Volume.from`/`to` describing chapters that moved, would strand all of it.
 *
 * Only `chapters` is written here. Every table that keys on a chapter does so through a composite
 * foreign key declared `ON UPDATE CASCADE`, so renumbering carries the script and everything hanging
 * off it in the same statement. Moving them by hand would be a second definition of the same
 * relationship, and the one that fell behind would do so silently.
 *
 * Numbers are parked above the range first because `(book_id, id)` is the primary key: renumbering
 * in place collides the moment a chapter takes a number its neighbour has not vacated yet.
 */
function renumber(tx: Tx, bookId: string): void {
  const OFFSET = 1_000_000;
  const vols = tx
    .select()
    .from(volumes)
    .where(eq(volumes.bookId, bookId))
    .orderBy(asc(volumes.position))
    .all();
  const rows = tx.select().from(chapters).where(eq(chapters.bookId, bookId)).all();
  const order = vols.flatMap((v) =>
    rows.filter((c) => c.volumeId === v.id).sort((a, b) => a.volumeIndex - b.volumeIndex),
  );

  tx.update(chapters)
    .set({ id: sql`${chapters.id} + ${OFFSET}` })
    .where(eq(chapters.bookId, bookId))
    .run();

  const perVolume = new Map<number, number>();
  order.forEach((c, i) => {
    const id = i + 1;
    const volumeIndex = (perVolume.get(c.volumeId) ?? 0) + 1;
    perVolume.set(c.volumeId, volumeIndex);
    tx.update(chapters)
      .set({ id, volumeIndex })
      .where(and(eq(chapters.bookId, bookId), eq(chapters.id, c.id + OFFSET)))
      .run();
  });

  let from = 1;
  for (const v of vols) {
    const n = order.filter((c) => c.volumeId === v.id).length;
    tx.update(volumes)
      .set({ fromIndex: from, toIndex: from + Math.max(0, n - 1) })
      .where(and(eq(volumes.bookId, bookId), eq(volumes.id, v.id)))
      .run();
    from += n;
  }
}

/** What taking a volume off left behind on disk, for the caller to remove once the rows are gone. */
export interface DeletedVolume {
  /** how many chapters went */
  chapters: number;
  /** the file names of every clip those chapters had rendered, under the book's audio directory */
  clips: string[];
  /** audiobooks that were only those chapters, and are gone with them: their files, by export */
  exports: { id: number; tokens: string[] }[];
}

/**
 * Take a volume off its book: its chapters and their text go, and the rest are renumbered.
 *
 * Everything keyed on a chapter follows by foreign key — the script, the clips, the history, an
 * audiobook's list of chapters — which is the demo's rule too: an export keeps the chapters it
 * still has, under their new numbers, and one left with none goes entirely. Two things do not
 * follow a key and are done here, in the same transaction: the book's live jobs get their duplicate
 * keys again (`rekeyActive`), and what the rows pointed at on disk is handed back to be removed.
 */
export function deleteVolume(db: Db, bookId: string, volumeId: number): DeletedVolume {
  const out: DeletedVolume = { chapters: 0, clips: [], exports: [] };
  db.transaction((tx) => {
    const mine = tx
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.volumeId, volumeId)))
      .all()
      .map((r) => r.id);
    const touched = new Set<number>();
    for (const part of chunked(mine)) {
      const within = and(eq(clips.bookId, bookId), inArray(clips.chapterId, part));
      for (const c of tx.select({ url: clips.url }).from(clips).where(within).all())
        if (c.url) out.clips.push(c.url.split("/").at(-1)!);
      for (const e of tx
        .select({ id: exportChapters.exportId })
        .from(exportChapters)
        .where(and(eq(exportChapters.bookId, bookId), inArray(exportChapters.chapterId, part)))
        .all())
        touched.add(e.id);
    }
    // the chapter's text, script, clips, history and its place in an export all cascade from this
    for (const part of chunked(mine))
      tx.delete(chapters)
        .where(and(eq(chapters.bookId, bookId), inArray(chapters.id, part)))
        .run();
    tx.delete(volumes)
      .where(and(eq(volumes.bookId, bookId), eq(volumes.id, volumeId)))
      .run();
    renumber(tx, bookId);
    rekeyActive(tx, bookId);

    for (const id of touched) {
      const left = tx
        .select({ n: count() })
        .from(exportChapters)
        .where(eq(exportChapters.exportId, id))
        .get()!.n;
      if (left) continue;
      const tokens = tx
        .select({ path: exportFiles.path })
        .from(exportFiles)
        .where(eq(exportFiles.exportId, id))
        .all()
        .flatMap((r) => (r.path ? [r.path] : []));
      tx.delete(exportItems).where(eq(exportItems.id, id)).run();
      out.exports.push({ id, tokens });
    }
    out.chapters = mine.length;
  });
  return out;
}

/** Everything a book owns. The foreign keys cascade the rest. */
export function deleteBook(db: Db, bookId: string): void {
  db.delete(books).where(eq(books.id, bookId)).run();
}

// ---------- a book's settings, and its volumes' names and order ----------

/** What a book's settings write says: a key left out is left alone, and `null` clears it. */
export interface BookSettings {
  budget?: { cap: number | null; paused: boolean } | null;
  scriptBudget?: number | null;
  pacing?: { line: number; turn: number } | null;
}

/**
 * Write the settings a request names, and nothing else.
 *
 * A budget and a pacing are each one value in two columns, and are written as one: the row reads
 * back a pacing only when both of its columns are set, so writing half of one would store a value
 * that reads as the default.
 */
export function setBookSettings(db: Db | Tx, bookId: string, s: BookSettings): void {
  const set: Partial<typeof books.$inferInsert> = {};
  if (s.budget !== undefined) {
    set.budgetCap = s.budget?.cap ?? null;
    set.budgetPaused = s.budget ? s.budget.paused : null;
  }
  if (s.scriptBudget !== undefined) set.scriptBudget = s.scriptBudget;
  if (s.pacing !== undefined) {
    set.pacingLine = s.pacing?.line ?? null;
    set.pacingTurn = s.pacing?.turn ?? null;
  }
  if (!Object.keys(set).length) return;
  db.update(books).set(set).where(eq(books.id, bookId)).run();
}

export function renameVolume(db: Db, bookId: string, volumeId: number, name: string): void {
  db.update(volumes)
    .set({ name })
    .where(and(eq(volumes.bookId, bookId), eq(volumes.id, volumeId)))
    .run();
}

/**
 * Put a book's volumes in this order, and number its chapters to follow it.
 *
 * The same renumbering a removal does, without the removal: every chapter keeps its place within
 * its volume, and everything it owns follows its new number by the cascade, with the live jobs'
 * duplicate keys rewritten in the same transaction (`rekeyActive`). `order` is every volume of the
 * book, checked by the caller.
 */
export function reorderVolumes(db: Db, bookId: string, order: readonly number[]): void {
  db.transaction((tx) => {
    order.forEach((id, position) =>
      tx
        .update(volumes)
        .set({ position })
        .where(and(eq(volumes.bookId, bookId), eq(volumes.id, id)))
        .run(),
    );
    renumber(tx, bookId);
    rekeyActive(tx, bookId);
  });
}
