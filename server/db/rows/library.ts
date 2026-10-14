// Books, volumes and chapters, between rows and the shapes the app reads.
// Rule for every mapper here: absent is not null. A chapter with no note has no `note` key.
import type {
  Book,
  BookPrompt,
  Chapter,
  ChapterCounts,
  ChapterNote,
  NarrationStatus,
  Pacing,
  ScriptingStatus,
  Volume,
} from "@/types";
import { DEFAULT_PACING } from "@/lib/speech";
import type { books, chapters, volumes } from "~/db/schema";

type BookRow = typeof books.$inferSelect;
type VolumeRow = typeof volumes.$inferSelect;
type ChapterRow = typeof chapters.$inferSelect;

/** A book's own pacing, or undefined for the default; unset inline pauses get default lengths. */
export function toPacing(
  row: Pick<BookRow, "pacingLine" | "pacingTurn" | "pacingInlineShort" | "pacingInlineLong">,
): Pacing | undefined {
  if (row.pacingLine == null || row.pacingTurn == null) return undefined;
  return {
    line: row.pacingLine,
    turn: row.pacingTurn,
    inlineShort: row.pacingInlineShort ?? DEFAULT_PACING.inlineShort,
    inlineLong: row.pacingInlineLong ?? DEFAULT_PACING.inlineLong,
  };
}

/** Rebuild a book from its row and its volumes, already in reading order. */
export function toBook(row: BookRow, vols: readonly VolumeRow[], counts?: ChapterCounts): Book {
  const book: Book = {
    id: row.id,
    title: row.title,
    author: row.author,
    cover: [row.coverFrom, row.coverTo],
    addedAt: new Date(row.addedAt).toISOString().slice(0, 10),
    volumes: vols.map(toVolume),
  };
  if (counts) book.chapters = counts;
  if (row.importing) book.importing = true;
  if (row.coverImage != null) book.coverImage = row.coverImage;
  // a budget exists once either half is set; absent differs from "no cap, not paused"
  if (row.budgetCap != null || row.budgetPaused != null)
    book.budget = { cap: row.budgetCap ?? null, paused: row.budgetPaused ?? false };
  if (row.scriptBudget != null) book.scriptBudget = row.scriptBudget;
  const pacing = toPacing(row);
  if (pacing) book.pacing = pacing;
  const prompt = toBookPrompt(row);
  if (prompt) book.prompt = prompt;
  if (row.readNotes != null) book.readNotes = row.readNotes;
  if (row.checkByEar != null) book.checkByEar = row.checkByEar;
  if (row.thoughts != null) book.thoughts = row.thoughts;
  if (row.characterVoice != null) book.characterVoice = row.characterVoice;
  return book;
}

/** Undefined when never set; the four columns are written together, so any one set is the value. */
function toBookPrompt(row: BookRow): BookPrompt | undefined {
  if (
    row.promptNotes == null &&
    row.promptReplace == null &&
    row.promptSystem == null &&
    row.promptUser == null
  )
    return undefined;
  return {
    notes: row.promptNotes ?? "",
    replace: row.promptReplace ?? false,
    system: row.promptSystem ?? "",
    user: row.promptUser ?? "",
  };
}

/** Undefined clears all four columns. */
export const bookPromptValues = (p: BookPrompt | null | undefined) => ({
  promptNotes: p?.notes ?? null,
  promptReplace: p ? p.replace : null,
  promptSystem: p?.system ?? null,
  promptUser: p?.user ?? null,
});

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

/** `addedAt` is epoch ms. */
export function bookValues(book: Book, addedAt: number): typeof books.$inferInsert {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    coverFrom: book.cover[0],
    coverTo: book.cover[1],
    coverImage: book.coverImage ?? null,
    addedAt,
    importing: !!book.importing,
    budgetCap: book.budget?.cap ?? null,
    budgetPaused: book.budget?.paused ?? null,
    scriptBudget: book.scriptBudget ?? null,
    pacingLine: book.pacing?.line ?? null,
    pacingTurn: book.pacing?.turn ?? null,
    pacingInlineShort: book.pacing?.inlineShort ?? null,
    pacingInlineLong: book.pacing?.inlineLong ?? null,
    ...bookPromptValues(book.prompt),
    readNotes: book.readNotes ?? null,
    checkByEar: book.checkByEar ?? null,
    thoughts: book.thoughts ?? null,
    characterVoice: book.characterVoice ?? null,
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
 * A chapter's stable id, for rows that must survive renumbering. Random, since one derived from
 * the chapter number would move and collide when a volume is removed.
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
