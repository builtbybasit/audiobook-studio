// Every read and write the library makes. An import writes a book, its volume, its chapters and
// their text in one transaction, so a crash mid-file leaves no half-imported book.
import { and, asc, count, desc, eq, inArray, lt, max, sql } from "drizzle-orm";

import type {
  Book,
  BookPrompt,
  Chapter,
  CharacterVoice,
  ChapterCounts,
  LineCounts,
  NarrationStatus,
  Pacing,
  ScriptingStatus,
  SegmentType,
  ThoughtChoice,
  Volume,
  VolumeStart,
} from "@/types";
import { chapterNumbers } from "@/lib/chapterNumber";
import { pacingOrDefault } from "@/lib/speech";
import { unspokenTypes } from "@/lib/siteText";
import type { Db, Tx } from "~/db/client";
import type { ChapterBody } from "~/import/assemble";
import { rekeyActive } from "~/db/jobs";
import { insertRows } from "~/db/prepared";
import {
  books,
  chapters,
  chapterTexts,
  clips,
  exportChapters,
  exportFiles,
  exportItems,
  segments,
  volumes,
} from "~/db/schema";
import {
  bookPromptValues,
  bookValues,
  chapterValues,
  toBook,
  toChapter,
  toPacing,
  volumeValues,
} from "~/db/rows";

/** Keeps an `IN (...)` under SQLite's parameter limit; a long web novel is thousands of rows. */
const CHUNK = 200;
const chunked = <T>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/** Each book's chapter counts in one grouped query, so a shelf card needs no chapter rows. */
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

/**
 * Whether the book, or the volume holding any of these chapters, is still in its contents review.
 * Nothing runs on such a chapter: Discard takes it away whole.
 */
export const inReview = (book: Book, chapterIds: readonly number[]): boolean =>
  !!book.importing ||
  book.volumes.some((v) => v.importing && chapterIds.some((id) => id >= v.from && id <= v.to));

/** A book's pacing, or the default when it has none of its own. */
export function readPacing(db: Db | Tx, bookId: string): Pacing {
  const row = db
    .select({
      pacingLine: books.pacingLine,
      pacingTurn: books.pacingTurn,
      pacingInlineShort: books.pacingInlineShort,
      pacingInlineLong: books.pacingInlineLong,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .get();
  return pacingOrDefault(row && toPacing(row));
}

export function listChapters(db: Db | Tx, bookId: string): Chapter[] {
  const readNotes = db
    .select({ readNotes: books.readNotes })
    .from(books)
    .where(eq(books.id, bookId))
    .get()?.readNotes;
  const lines = lineCounts(db, bookId, unspokenTypes({ readNotes: readNotes ?? undefined }));
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.id))
    .all()
    .map((row) => ({ ...toChapter(row), lines: lines.get(row.id) ?? NO_LINES }));
}

const NO_LINES: LineCounts = { total: 0, done: 0, generating: 0, failed: 0, skipped: 0 };

/**
 * Each chapter's lines counted by the clip each one plays, in one pass over the book. `unspoken`
 * lines want no clip, so they count as `skipped` rather than in the total.
 */
function lineCounts(
  db: Db | Tx,
  bookId: string,
  unspoken: readonly SegmentType[],
): Map<number, LineCounts> {
  const quiet = unspoken.length ? inArray(segments.type, [...unspoken]) : sql`0`;
  const heard = (status: string) =>
    sql<number>`sum(case when ${quiet} then 0 when ${clips.status} = ${status} then 1 else 0 end)`;
  const rows = db
    .select({
      chapterId: segments.chapterId,
      total: sql<number>`sum(case when ${quiet} then 0 else 1 end)`,
      done: heard("done"),
      generating: heard("generating"),
      failed: heard("failed"),
      skipped: sql<number>`sum(case when ${quiet} then 1 else 0 end)`,
      mended: sql<number>`sum(case when ${segments.mended} is null then 0 else 1 end)`,
    })
    .from(segments)
    .leftJoin(
      clips,
      and(
        eq(clips.bookId, segments.bookId),
        eq(clips.chapterId, segments.chapterId),
        eq(clips.segmentId, segments.id),
        eq(clips.role, "current"),
      ),
    )
    .where(eq(segments.bookId, bookId))
    .groupBy(segments.chapterId)
    .all();
  return new Map(
    rows.map((r) => [
      r.chapterId,
      {
        total: Number(r.total),
        done: Number(r.done),
        generating: Number(r.generating),
        failed: Number(r.failed),
        skipped: Number(r.skipped),
        ...(Number(r.mended) ? { mended: Number(r.mended) } : {}),
      },
    ]),
  );
}

/** One chapter of one book, by the number it goes by now. */
export const chapterAt = (bookId: string, id: number) =>
  and(eq(chapters.bookId, bookId), eq(chapters.id, id));

export function getChapter(db: Db | Tx, bookId: string, id: number): Chapter | undefined {
  const row = db.select().from(chapters).where(chapterAt(bookId, id)).get();
  return row ? toChapter(row) : undefined;
}

export function chapterExists(db: Db | Tx, bookId: string, id: number): boolean {
  return !!db.select({ id: chapters.id }).from(chapters).where(chapterAt(bookId, id)).get();
}

export function chapterIds(db: Db | Tx, bookId: string): number[] {
  return db
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.id))
    .all()
    .map((c) => c.id);
}

/** "chapter 2" by reading number, never by id (which counts cover and contents pages too). */
export const chapterName = (db: Db | Tx, bookId: string, id: number): string =>
  nameOf(readingNumber(db, bookId, id));

/** A chapter's place among the kept chapters (`chapterNumbers`); undefined when skipped or absent. */
export function readingNumber(db: Db | Tx, bookId: string, id: number): number | undefined {
  const all = db
    .select({ id: chapters.id, excluded: chapters.excluded })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .all();
  return chapterNumbers(all.map((c) => ({ id: c.id, excluded: !!c.excluded }))).get(id);
}

export const nameOf = (n: number | undefined): string =>
  n == null ? "a skipped chapter" : `chapter ${n}`;

/**
 * The identity a chapter keeps whatever number it goes by. Jobs find their chapter by it at every
 * write (`locateChapter`): removing an earlier volume renumbers the book under a running job.
 */
export function chapterUid(db: Db | Tx, bookId: string, id: number): string | undefined {
  return db.select({ uid: chapters.uid }).from(chapters).where(chapterAt(bookId, id)).get()?.uid;
}

/** Where a chapter is now, by uid; undefined once it has gone. */
export function locateChapter(
  db: Db | Tx,
  uid: string,
): { bookId: string; id: number } | undefined {
  return db
    .select({ bookId: chapters.bookId, id: chapters.id })
    .from(chapters)
    .where(eq(chapters.uid, uid))
    .get();
}

/** A chapter's own recap; "" when it has none. */
export function chapterRecap(db: Db | Tx, bookId: string, chapterId: number): string {
  const row = db
    .select({ recap: chapters.recap })
    .from(chapters)
    .where(chapterAt(bookId, chapterId))
    .get();
  return row?.recap ?? "";
}

/** Keep where a chapter's script leaves off, for the chapter after it. */
export function setChapterRecap(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  recap: string | null,
): void {
  db.update(chapters).set({ recap }).where(chapterAt(bookId, chapterId)).run();
}

/**
 * The recap of the nearest earlier kept chapter, or "" when that one has none: an older chapter's
 * recap would be the wrong scene, so the search stops there.
 */
export function previousRecap(db: Db | Tx, bookId: string, chapterId: number): string {
  const row = db
    .select({ recap: chapters.recap })
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        lt(chapters.id, chapterId),
        sql`coalesce(${chapters.excluded}, 0) = 0`,
      ),
    )
    .orderBy(desc(chapters.id))
    .get();
  return row?.recap ?? "";
}

export function setChapterScripting(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  scripting: ScriptingStatus,
  progress: number,
): void {
  db.update(chapters)
    .set({ scripting, scriptingProgress: progress })
    .where(chapterAt(bookId, chapterId))
    .run();
}

export function setChapterNarration(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  narration: NarrationStatus,
  progress?: number,
  duration?: number,
): void {
  db.update(chapters)
    .set({
      narration,
      ...(progress != null ? { narrationProgress: progress } : {}),
      ...(duration != null ? { duration } : {}),
    })
    .where(chapterAt(bookId, chapterId))
    .run();
}

/** Seconds; leaves the status alone, for a pacing change that re-times the chapter. */
export function setChapterDuration(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  duration: number,
): void {
  db.update(chapters).set({ duration }).where(chapterAt(bookId, chapterId)).run();
}

export function getChapterBody(db: Db, bookId: string, chapterId: number): string | undefined {
  return db
    .select({ body: chapterTexts.body })
    .from(chapterTexts)
    .where(and(eq(chapterTexts.bookId, bookId), eq(chapterTexts.chapterId, chapterId)))
    .get()?.body;
}

/**
 * Chapters whose text names `name` as a whole word, same case, in book order. Searches the stored
 * Markdown, so a name split by emphasis ("*Lord* of Shadows") is not found.
 */
export function chaptersMentioning(db: Db, bookId: string, name: string): number[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u");
  // ponytail: every candidate body is read and scanned; an FTS index if a common name gets slow
  return db
    .select({ id: chapterTexts.chapterId, body: chapterTexts.body })
    .from(chapterTexts)
    .where(and(eq(chapterTexts.bookId, bookId), sql`instr(${chapterTexts.body}, ${name}) > 0`))
    .orderBy(asc(chapterTexts.chapterId))
    .all()
    .filter((c) => word.test(c.body))
    .map((c) => c.id);
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

/** Write a whole imported book, in one transaction. */
export function insertBook(
  db: Db | Tx,
  book: Book,
  chs: readonly Chapter[],
  bodies: readonly ChapterBody[],
  addedAt = Date.now(),
): void {
  db.transaction((tx) => {
    tx.insert(books).values(bookValues(book, addedAt)).run();
    insertRows(
      tx,
      volumes,
      book.volumes.map((v, i) => volumeValues(book.id, v, i)),
    );
    insertRows(
      tx,
      chapters,
      chs.map((c) => chapterValues(book.id, c)),
    );
    insertRows(
      tx,
      chapterTexts,
      bodies.map((b) => ({ bookId: book.id, chapterId: b.chapterId, body: b.body })),
    );
  });
}

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
    insertRows(
      tx,
      chapters,
      chs.map((c) => chapterValues(bookId, c)),
    );
    insertRows(
      tx,
      chapterTexts,
      bodies.map((b) => ({ bookId, chapterId: b.chapterId, body: b.body })),
    );
  });
}

export function lastChapterNumber(db: Db, bookId: string): number {
  return (
    db
      .select({ n: max(chapters.id) })
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .get()?.n ?? 0
  );
}

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
 * Skip chapters for the audiobook, or include them again; a skipped chapter keeps its text and
 * number. Including a chapter with a note marks it `kept`, so the suggestion stops asking.
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
          .where(chapterAt(bookId, row.id))
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
          .where(chapterAt(bookId, row.id))
          .run();
        changed++;
      }
    }
  });
  return changed;
}

export interface ReviewDecision {
  id: number;
  excluded?: boolean;
  kept?: boolean;
}

/**
 * Put chapters' review decisions to exactly these: the undo primitive. `setSkipped` applies a rule
 * that cannot run backwards (an undone skip would come back `kept`). A chapter not in the book is
 * skipped, not refused, so the rest of the batch still lands.
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
        tx.update(chapters).set({ excluded, kept }).where(chapterAt(bookId, d.id)).run();
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
 * Give a book's chapters the numbers 1..n in reading order, and put the volume ranges back. Only
 * `chapters` is written: every table keyed on a chapter follows by `ON UPDATE CASCADE`. Numbers
 * are parked above the range first because `(book_id, id)` is the primary key, and renumbering in
 * place collides with a neighbour that has not moved yet.
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
      .where(chapterAt(bookId, c.id + OFFSET))
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

/** A clip row's files on disk: the one it plays and, when effects made it, the dry `raw` one. */
export const clipFiles = (c: { url: string | null; raw: string | null }): string[] =>
  [c.url, c.raw].flatMap((u) => (u ? [u.split("/").at(-1)!] : []));

/** What taking a volume off left behind on disk, for the caller to remove once the rows are gone. */
export interface DeletedVolume {
  chapters: number;
  /** file names under the book's audio directory */
  clips: string[];
  /** audiobooks that were only those chapters, and went with them */
  exports: { id: number; tokens: string[] }[];
}

/**
 * Take a volume off its book and renumber the rest; everything keyed on a chapter cascades. An
 * export left with no chapters goes entirely. Live jobs' keys are rewritten here (`rekeyActive`),
 * since they follow no foreign key.
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
      for (const c of tx.select({ url: clips.url, raw: clips.raw }).from(clips).where(within).all())
        out.clips.push(...clipFiles(c));
      for (const e of tx
        .select({ id: exportChapters.exportId })
        .from(exportChapters)
        .where(and(eq(exportChapters.bookId, bookId), inArray(exportChapters.chapterId, part)))
        .all())
        touched.add(e.id);
    }
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

/** The foreign keys cascade everything the book owns. */
export function deleteBook(db: Db, bookId: string): void {
  db.delete(books).where(eq(books.id, bookId)).run();
}

// ---------- a book's settings, and its volumes' names and order ----------

/** What a book's settings write says: a key left out is left alone, and `null` clears it. */
export interface BookSettings {
  budget?: { cap: number | null; paused: boolean } | null;
  scriptBudget?: number | null;
  pacing?: Pacing | null;
  prompt?: BookPrompt | null;
  /** read `note` lines aloud; `null` goes back to skipping them */
  readNotes?: boolean | null;
  /** transcribe each chapter once narrated; `null` goes back to only when asked */
  autoTranscribe?: boolean | null;
  /** stop the scripting model suggesting dictionary terms; `null` lets it again */
  pronounceOff?: boolean | null;
  /** show exact line counts on the Cast page; `null` goes back to rough ones */
  exactCounts?: boolean | null;
  /** an effect's id or "none"; `null` follows the library's */
  thoughts?: ThoughtChoice | null;
  /** the voice for speakers with none of their own; `null` goes back to the Narrator's */
  characterVoice?: CharacterVoice | null;
}

/**
 * Write the settings a request names, and nothing else. A budget, pacing or prompt spans several
 * columns and is written whole: a half-written pacing would read back as the default.
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
    set.pacingInlineShort = s.pacing?.inlineShort ?? null;
    set.pacingInlineLong = s.pacing?.inlineLong ?? null;
  }
  if (s.prompt !== undefined) Object.assign(set, bookPromptValues(s.prompt));
  if (s.readNotes !== undefined) set.readNotes = s.readNotes;
  if (s.autoTranscribe !== undefined) set.autoTranscribe = s.autoTranscribe;
  if (s.pronounceOff !== undefined) set.pronounceOff = s.pronounceOff;
  if (s.exactCounts !== undefined) set.exactCounts = s.exactCounts;
  if (s.thoughts !== undefined) set.thoughts = s.thoughts;
  if (s.characterVoice !== undefined) set.characterVoice = s.characterVoice;
  if (!Object.keys(set).length) return;
  db.update(books).set(set).where(eq(books.id, bookId)).run();
}

export function setBookCover(db: Db, bookId: string, url: string): void {
  db.update(books).set({ coverImage: url }).where(eq(books.id, bookId)).run();
}

export function renameVolume(db: Db, bookId: string, volumeId: number, name: string): void {
  db.update(volumes)
    .set({ name })
    .where(and(eq(volumes.bookId, bookId), eq(volumes.id, volumeId)))
    .run();
}

/**
 * Cut a book into volumes at these starts (reading order; the caller checks the first is chapter 1).
 * Each start reuses the first untaken volume its chapters are in, so a moved boundary keeps both
 * rows; otherwise a new row copies its parent's file and review state. Empty rows go. Chapter
 * numbers do not move.
 */
export function setVolumes(db: Db, bookId: string, starts: readonly VolumeStart[]): void {
  db.transaction((tx) => {
    const vols = tx.select().from(volumes).where(eq(volumes.bookId, bookId)).all();
    const rows = tx
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .orderBy(asc(chapters.id))
      .all();
    const byId = new Map(vols.map((v) => [v.id, v]));
    let nextId = Math.max(0, ...vols.map((v) => v.id));
    const kept = new Set<number>();
    starts.forEach((start, position) => {
      const end = starts[position + 1]?.chapter ?? Infinity;
      const mine = rows.filter((c) => c.id >= start.chapter && c.id < end);
      if (!mine.length) return;
      const parent = byId.get(mine[0].volumeId)!;
      let id = mine.map((c) => c.volumeId).find((v) => !kept.has(v));
      if (id == null) {
        id = ++nextId;
        tx.insert(volumes)
          .values(
            volumeValues(
              bookId,
              {
                id,
                name: start.name,
                file: parent.file,
                from: 0,
                to: 0,
                importing: parent.importing,
              },
              position,
            ),
          )
          .run();
      } else
        tx.update(volumes)
          .set({ name: start.name, position })
          .where(and(eq(volumes.bookId, bookId), eq(volumes.id, id)))
          .run();
      kept.add(id);
      mine.forEach((c, i) =>
        tx
          .update(chapters)
          .set({ volumeId: id, volumeIndex: i + 1 })
          .where(and(eq(chapters.bookId, bookId), eq(chapters.id, c.id)))
          .run(),
      );
    });
    for (const v of vols)
      if (!kept.has(v.id))
        tx.delete(volumes)
          .where(and(eq(volumes.bookId, bookId), eq(volumes.id, v.id)))
          .run();
    renumber(tx, bookId);
  });
}

/** Put a book's volumes in this order (every volume, checked by the caller) and renumber. */
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
