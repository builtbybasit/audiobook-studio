// Books, volumes and chapters, between rows and the shapes the app reads.
//
// One rule holds across every file in this directory: **absent is not null**. The domain marks
// things by leaving them out — a chapter with no note has no `note` key, not a null one — and a
// mapper that hands back `{ note: null }` produces an object that compares unequal to the one that
// went in, and a UI that renders "null" where it should render nothing.
import type { Book, Chapter, ChapterNote, NarrationStatus, ScriptingStatus, Volume } from "@/types";
import type { books, chapters, volumes } from "~/db/schema";

type BookRow = typeof books.$inferSelect;
type VolumeRow = typeof volumes.$inferSelect;
type ChapterRow = typeof chapters.$inferSelect;

/** Rebuild a book from its row and the volumes that belong to it, already in reading order. */
export function toBook(row: BookRow, vols: readonly VolumeRow[]): Book {
  const book: Book = {
    id: row.id,
    title: row.title,
    author: row.author,
    cover: [row.coverFrom, row.coverTo],
    addedAt: new Date(row.addedAt).toISOString().slice(0, 10),
    volumes: vols.map(toVolume),
  };
  if (row.importing) book.importing = true;
  // A budget exists once either half of it has been set; absent is not the same as "no cap, not
  // paused", and the overview reads the difference.
  if (row.budgetCap != null || row.budgetPaused != null)
    book.budget = { cap: row.budgetCap ?? null, paused: row.budgetPaused ?? false };
  if (row.scriptBudget != null) book.scriptBudget = row.scriptBudget;
  if (row.pacingLine != null && row.pacingTurn != null)
    book.pacing = { line: row.pacingLine, turn: row.pacingTurn };
  return book;
}

export function toVolume(row: VolumeRow): Volume {
  const v: Volume = {
    id: row.id,
    name: row.name,
    file: row.file,
    from: row.fromIndex,
    to: row.toIndex,
  };
  if (row.importing) v.importing = true;
  return v;
}

export function toChapter(row: ChapterRow): Chapter {
  const c: Chapter = {
    id: row.id,
    index: row.id,
    volumeId: row.volumeId,
    volumeIndex: row.volumeIndex,
    title: row.title,
    words: row.words,
    scripting: row.scripting as ScriptingStatus,
    scriptingProgress: row.scriptingProgress,
    narration: row.narration as NarrationStatus,
    narrationProgress: row.narrationProgress,
    duration: row.duration,
  };
  if (row.excluded) c.excluded = true;
  if (row.kept) c.kept = true;
  if (row.note) c.note = row.note as ChapterNote;
  return c;
}

/** A book, flattened for insertion. `addedAt` arrives as the epoch ms the caller recorded. */
export function bookValues(book: Book, addedAt: number): typeof books.$inferInsert {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    coverFrom: book.cover[0],
    coverTo: book.cover[1],
    addedAt,
    importing: !!book.importing,
    budgetCap: book.budget?.cap ?? null,
    budgetPaused: book.budget?.paused ?? null,
    scriptBudget: book.scriptBudget ?? null,
    pacingLine: book.pacing?.line ?? null,
    pacingTurn: book.pacing?.turn ?? null,
  };
}

export function volumeValues(
  bookId: string,
  volume: Volume,
  position: number,
): typeof volumes.$inferInsert {
  return {
    bookId,
    id: volume.id,
    name: volume.name,
    file: volume.file,
    fromIndex: volume.from,
    toIndex: volume.to,
    position,
    importing: !!volume.importing,
  };
}

/**
 * A chapter's own id, for the rows that must not be rewritten when chapters are renumbered.
 *
 * Random rather than derived. Anything built out of the book id and the chapter number would be
 * exactly the moving address it exists to avoid, and would collide the first time a volume was
 * removed and a later chapter took a number an earlier one had already been spent against.
 */
export const newChapterUid = (): string => crypto.randomUUID();

export function chapterValues(
  bookId: string,
  c: Chapter,
  uid: string = newChapterUid(),
): typeof chapters.$inferInsert {
  return {
    bookId,
    id: c.id,
    uid,
    volumeId: c.volumeId,
    volumeIndex: c.volumeIndex,
    title: c.title,
    words: c.words,
    scripting: c.scripting,
    scriptingProgress: c.scriptingProgress,
    narration: c.narration,
    narrationProgress: c.narrationProgress,
    duration: c.duration,
    excluded: c.excluded ?? null,
    kept: c.kept ?? null,
    note: c.note ?? null,
  };
}
