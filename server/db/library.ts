// Every read and write the library makes.
//
// The routes call these and nothing else: no route builds a query, and no query knows it is being
// served over HTTP. An import writes a book, its volume, its chapters and their text in one
// transaction, so a crash halfway through a nine-hundred-chapter file leaves no half-imported book
// behind for the review to choke on.
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";

import type { Book, Chapter, Volume } from "@/types";
import type { Db, Tx } from "~/db/client";
import type { ChapterBody } from "~/import/assemble";
import { books, chapters, chapterTexts, volumes } from "~/db/schema";
import { bookValues, chapterValues, toBook, toChapter, volumeValues } from "~/db/rows";

/** SQLite takes its parameters one variable at a time, and a long web novel is thousands of rows. */
const CHUNK = 200;
const chunked = <T>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

export function listBooks(db: Db): Book[] {
  const rows = db.select().from(books).orderBy(asc(books.addedAt), asc(books.id)).all();
  const vols = db.select().from(volumes).orderBy(asc(volumes.position)).all();
  return rows.map((b) =>
    toBook(
      b,
      vols.filter((v) => v.bookId === b.id),
    ),
  );
}

export function getBook(db: Db, id: string): Book | undefined {
  const row = db.select().from(books).where(eq(books.id, id)).get();
  if (!row) return undefined;
  const vols = db
    .select()
    .from(volumes)
    .where(eq(volumes.bookId, id))
    .orderBy(asc(volumes.position))
    .all();
  return toBook(row, vols);
}

export function listChapters(db: Db, bookId: string): Chapter[] {
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.id))
    .all()
    .map(toChapter);
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

/** Take a volume off its book: its chapters and their text go, and the rest are renumbered. */
export function deleteVolume(db: Db, bookId: string, volumeId: number): number {
  let gone = 0;
  db.transaction((tx) => {
    const mine = tx
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.volumeId, volumeId)))
      .all()
      .map((r) => r.id);
    // the chapter's text, script, clips and history all cascade from this one delete
    for (const part of chunked(mine))
      tx.delete(chapters)
        .where(and(eq(chapters.bookId, bookId), inArray(chapters.id, part)))
        .run();
    tx.delete(volumes)
      .where(and(eq(volumes.bookId, bookId), eq(volumes.id, volumeId)))
      .run();
    renumber(tx, bookId);
    gone = mine.length;
  });
  return gone;
}

/** Everything a book owns. The foreign keys cascade the rest. */
export function deleteBook(db: Db, bookId: string): void {
  db.delete(books).where(eq(books.id, bookId)).run();
}
