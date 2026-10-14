// The library's operations and their rules (volumes, imports, removal). Routes, jobs and tests
// call them; a broken rule throws an `AppError`, which `app.onError` turns into the API's error.
import type {
  Book,
  BookUpdated,
  Chapter,
  ImportedBook,
  Pacing,
  RevisedLines,
  VolumeStart,
} from "@/types";
import { chapterSeconds, pacingOrDefault } from "@/lib/speech";
import type { AudioFiles } from "~/audio/files";
import { MAX_COVER_BYTES, sniffCover, type CoverFiles } from "~/covers/files";
import type { AudiobookFiles } from "~/exports/files";
import type { Db, Tx } from "~/db/client";
import * as queue from "~/db/jobs";
import * as library from "~/db/library";
import { bumpRevision, readScript, writeClip } from "~/db/script";
import { requireEffect } from "~/effects/ops";
import { env } from "~/env";
import { checkArchive } from "~/epub/archive";
import { diagnose } from "~/epub/diagnose";
import { plainText } from "~/epub/markdown";
import { EpubParseError, parseEpub, type ParsedEpub } from "~/epub/parse";
import { assembleBook, assembleVolume } from "~/import/assemble";
import type { Runner } from "~/jobs/runner";
import { AppError, badRequest, conflict, notFound } from "~/lib/errors";
import { slugify } from "~/lib/http";
import { inBackground } from "~/lib/background";
import { narrationInProgress, settleChapter } from "~/narration/chapter";

/** Enough of a logger for an import; `hono-pino`'s context logger is not a pino `Logger`. */
export interface ImportLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Includes books still importing. */
export const listBooks = (db: Db): Book[] => library.listBooks(db);

export function requireBook(db: Db, bookId: string): Book {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  return book;
}

export function bookWithChapters(db: Db, bookId: string): ImportedBook {
  const book = requireBook(db, bookId);
  return { book, chapters: library.listChapters(db, book.id) };
}

/** See `LibraryService.chapterText` for why there are two forms. */
export function chapterText(
  db: Db,
  bookId: string,
  chapterId: number,
  format: "markdown" | "plain",
): string {
  const body = library.getChapterBody(db, bookId, chapterId);
  if (body == null) throw notFound("No such chapter");
  return format === "plain" ? plainText(body) : body;
}

/** Several chapters' prose at once, by id; a chapter the book does not have is left out. */
export function chapterTexts(
  db: Db,
  bookId: string,
  chapterIds: readonly number[],
  format: "markdown" | "plain",
): Record<number, string> {
  requireBook(db, bookId);
  const texts: Record<number, string> = {};
  for (const id of chapterIds) {
    const body = library.getChapterBody(db, bookId, id);
    if (body != null) texts[id] = format === "plain" ? plainText(body) : body;
  }
  return texts;
}

/** For each name, the chapters whose text contains it as written. */
export function chaptersMentioning(
  db: Db,
  bookId: string,
  names: readonly string[],
): Record<string, number[]> {
  requireBook(db, bookId);
  return Object.fromEntries(names.map((n) => [n, library.chaptersMentioning(db, bookId, n)]));
}

// ---------- importing ----------

export interface ImportInput {
  bytes: ArrayBuffer;
  /** becomes the volume's `file` */
  fileName: string;
  /** override the title the EPUB declares */
  title?: string;
  /** add the file to this book as one more volume */
  bookId?: string;
  /** the volume's name; only read when `bookId` is set */
  name?: string;
  /** where a new book's cover image is kept; without it the book keeps none */
  covers?: CoverFiles;
}

export interface Imported extends ImportedBook {
  /** set when the file was added to an existing book */
  volumeId?: number;
  read: { chapters: number; words: number; unreadable: number; ms: number };
}

/**
 * The book an uploaded volume is going onto, or a refusal. `importEpub` asks before parsing (to
 * refuse fast) and again at insert, since a review could have started in between.
 */
export function volumeTarget(db: Db, bookId: string): Book {
  const book = requireBook(db, bookId);
  if (book.volumes.some((vol) => vol.importing))
    throw conflict(`“${book.title}” already has a volume waiting in its contents review`);
  return book;
}

/** Refuse an unparseable EPUB with the parser's reason plus EPUBCheck's, which runs only here. */
async function refused(bytes: ArrayBuffer, e: EpubParseError, log?: ImportLog): Promise<never> {
  const why = await diagnose(bytes);
  log?.warn({ reason: e.message, epubcheck: why }, "refused the file");
  throw new AppError(
    415,
    "That file could not be read as an EPUB",
    [e.message, why].filter(Boolean).join(" "),
  );
}

/** Read an uploaded EPUB into a new book, or into one more volume of an existing book. */
export async function importEpub(db: Db, input: ImportInput, log?: ImportLog): Promise<Imported> {
  const { bytes, fileName, title, bookId, name, covers } = input;

  // Refuse before parsing: a thousand-chapter EPUB is seconds of work. Asked again below.
  if (bookId) volumeTarget(db, bookId);

  const started = performance.now();
  let parsed: ParsedEpub;
  try {
    // Unzipped size is what costs memory. A refusal is a 413 and skips the diagnosis below.
    await checkArchive(bytes, {
      total: env.MAX_UNZIPPED_MB * 1024 * 1024,
      document: env.MAX_DOCUMENT_MB * 1024 * 1024,
    });
    parsed = await parseEpub(bytes);
  } catch (e) {
    if (!(e instanceof EpubParseError)) throw e;
    return refused(bytes, e, log);
  }

  // Warn on `unreadable`: a half-worked import otherwise looks like one that worked.
  const unreadable = parsed.chapters.filter((ch) => ch.unreadable).length;
  const read = {
    chapters: parsed.chapters.length,
    words: parsed.chapters.reduce((n, ch) => n + ch.words, 0),
    unreadable,
    ms: Math.round(performance.now() - started),
  };
  if (unreadable) log?.warn(read, "some chapters could not be read");
  else log?.info({ ...read, unreadable: undefined }, "read the file");

  if (bookId) {
    const book = volumeTarget(db, bookId);
    const { volume, chapters, bodies } = assembleVolume(
      parsed.chapters,
      library.lastVolumeId(db, bookId) + 1,
      library.lastChapterNumber(db, bookId) + 1,
      { name: name?.trim() || `Vol. ${book.volumes.length + 1}`, file: fileName },
    );
    library.insertVolume(db, bookId, volume, chapters, bodies);
    log?.info({ book: bookId, volume: volume.id, chapters: chapters.length }, "added a volume");
    return { ...bookWithChapters(db, bookId), volumeId: volume.id, read };
  }

  const id = library.freeBookId(db, slugify(title?.trim() || parsed.title || fileName));
  const assembled = assembleBook(parsed, id, fileName, { title });
  // Only a new book takes the EPUB's cover; a later volume's is often another edition's.
  const cover = covers && parsed.cover ? await keepCover(covers, id, parsed.cover, log) : null;
  if (cover) assembled.book.coverImage = cover;
  library.insertBook(db, assembled.book, assembled.chapters, assembled.bodies);
  log?.info(
    { book: id, title: assembled.book.title, chapters: assembled.chapters.length },
    "stored a new book",
  );
  return { ...bookWithChapters(db, id), read };
}

/** Keep the EPUB's cover if it is a JPEG or PNG of a sane size; otherwise log why not. */
async function keepCover(
  covers: CoverFiles,
  bookId: string,
  bytes: Uint8Array,
  log?: ImportLog,
): Promise<string | null> {
  const type = sniffCover(bytes);
  if (!type || bytes.byteLength > MAX_COVER_BYTES) {
    log?.info(
      { bytes: bytes.byteLength },
      type ? "the cover is too large to keep" : "the cover is not a JPEG or PNG; it was not kept",
    );
    return null;
  }
  return (await covers.write(bookId, bytes, type)).url;
}

/**
 * Keep an image for a book's audiobook and return its url. It does not replace the book's own
 * cover; an export's settings name it. The same image twice is the same file and url.
 */
export async function uploadCover(
  db: Db,
  covers: CoverFiles,
  bookId: string,
  bytes: Uint8Array,
): Promise<{ cover: string }> {
  requireBook(db, bookId);
  if (!bytes.byteLength) throw badRequest("That image is empty");
  if (bytes.byteLength > MAX_COVER_BYTES)
    throw new AppError(
      413,
      `That image is larger than ${MAX_COVER_BYTES / 1024 / 1024} MB`,
      "A cover a store asks for — a 3000-pixel square JPEG — is a few megabytes at most.",
    );
  const type = sniffCover(bytes);
  if (!type)
    throw new AppError(
      415,
      "A cover has to be a JPEG or PNG image",
      "Those are the pictures an M4B and an MP3 carry that every player shows.",
    );
  return { cover: (await covers.write(bookId, bytes, type)).url };
}

/** Make an image the book's own cover. The EPUB's image stays on disk under its own url. */
export async function changeBookCover(
  db: Db,
  covers: CoverFiles,
  bookId: string,
  bytes: Uint8Array,
): Promise<Book> {
  const { cover } = await uploadCover(db, covers, bookId, bytes);
  library.setBookCover(db, bookId, cover);
  return requireBook(db, bookId);
}

/** The review is done: the book, or its new volume, joins the library. Nothing starts running. */
export function confirmImport(db: Db, bookId: string): Book {
  requireBook(db, bookId);
  library.confirmImport(db, bookId);
  return requireBook(db, bookId);
}

export type Discarded =
  | { discarded: "book" }
  | { discarded: "volume"; volumeId: number; chapters: number };

/** Cancel an import: a new book goes entirely; a new volume comes off its book. */
export function discardImport(db: Db, bookId: string): Discarded {
  const book = requireBook(db, bookId);
  if (book.importing) {
    library.deleteBook(db, bookId);
    return { discarded: "book" };
  }
  const vol = book.volumes.find((x) => x.importing);
  if (!vol) throw conflict("Nothing is waiting in this book’s contents review");
  // Nothing has run on a volume in review, so there is nothing on disk to remove.
  const { chapters } = library.deleteVolume(db, bookId, vol.id);
  return { discarded: "volume", volumeId: vol.id, chapters };
}

// ---------- the contents review ----------

export type ReviewDecision = "skip" | "include" | "keep";

/** Skip chapters, include them again, or keep a noted one (no more suggestion). Deletes nothing. */
export function reviewChapters(
  db: Db,
  bookId: string,
  decision: ReviewDecision,
  ids: readonly number[],
): { changed: number; chapters: Chapter[] } {
  requireBook(db, bookId);
  const changed =
    decision === "keep"
      ? library.setKept(db, bookId, ids)
      : library.setSkipped(db, bookId, ids, decision === "skip");
  return { changed, chapters: library.listChapters(db, bookId) };
}

/** Set review decisions to exactly these: the undo primitive, restoring rather than re-deriving. */
export function setDecisions(
  db: Db,
  bookId: string,
  decisions: readonly library.ReviewDecision[],
): { changed: number; chapters: Chapter[] } {
  requireBook(db, bookId);
  const changed = library.setDecisions(db, bookId, decisions);
  return { changed, chapters: library.listChapters(db, bookId) };
}

// ---------- removal ----------

/**
 * Remove a book and everything it owns. Live jobs are cancelled and awaited first: a running job
 * would recreate the directories, and its `onSettled` needs the rows. Files go after the rows (a
 * leaked directory beats a chapter that plays nothing), in the background so a slow disk can't
 * hold the response.
 */
export async function removeBook(
  db: Db,
  bookId: string,
  { runner, files, built }: VolumePorts = {},
): Promise<void> {
  requireBook(db, bookId);
  if (runner) {
    const live = queue
      .listJobs(db, { bookId })
      .filter((job) => job.status === "queued" || job.status === "running");
    for (const job of live) runner.cancel(job.id);
    for (const job of live) await runner.finished(job.id);
  }
  library.deleteBook(db, bookId);
  inBackground(files?.removeBook(bookId), "could not remove a book's clips", { book: bookId });
  inBackground(built?.removeBook(bookId), "could not remove a book's audiobooks", { book: bookId });
}

export type Removed = { removed: "book" } | { removed: "volume"; chapters: number };

export interface VolumePorts {
  runner?: Runner;
  files?: AudioFiles;
  built?: AudiobookFiles;
}

/**
 * Remove a volume; the rest are renumbered and the last one takes the book with it. Jobs on its
 * chapters are cancelled; others carry on under new numbers. Refused mid-build: a build records
 * where each chapter landed by number. Files go after the rows, in the background.
 */
export async function removeVolume(
  db: Db,
  bookId: string,
  volumeId: number,
  { runner, files, built }: VolumePorts = {},
): Promise<Removed> {
  const book = requireBook(db, bookId);
  if (!book.volumes.some((x) => x.id === volumeId)) throw notFound("No such volume");
  if (queue.activeJob(db, "export", bookId, null))
    throw conflict(
      `An audiobook of “${book.title}” is being built`,
      "Let the build finish, or cancel it from the Queue, before removing a volume.",
    );
  if (book.volumes.length <= 1) {
    await removeBook(db, bookId, { runner, files, built });
    return { removed: "book" };
  }

  const going = new Set(
    library
      .listChapters(db, bookId)
      .filter((ch) => ch.volumeId === volumeId)
      .map((ch) => ch.id),
  );
  for (const job of queue.listJobs(db, { bookId }))
    if (
      (job.status === "queued" || job.status === "running") &&
      job.chapterId != null &&
      going.has(job.chapterId)
    )
      runner?.cancel(job.id);

  const gone = library.deleteVolume(db, bookId, volumeId);
  inBackground(files?.remove(bookId, gone.clips), "could not remove a volume's clips", {
    book: bookId,
    volume: volumeId,
  });
  for (const e of gone.exports)
    inBackground(built?.remove(bookId, e.tokens), "could not remove an audiobook's files", {
      book: bookId,
      export: e.id,
    });
  return { removed: "volume", chapters: gone.chapters };
}

// ---------- a book's settings, and its volumes' names and order ----------

/**
 * Write a book's settings. Pacing is stitched between clips, so a change only re-times narrated
 * chapters, except inline pause lengths, which are rendered and stale their clips (`stalePauses`).
 * Toggling `readNotes` changes which lines are spoken, so narrated chapters are settled again
 * (a chapter a run holds is settled by the run).
 */
export function updateBook(db: Db, bookId: string, settings: library.BookSettings): BookUpdated {
  const before = requireBook(db, bookId);
  requireEffect(db, settings.thoughts, "The book's thought effect");
  const notesMoved =
    settings.readNotes !== undefined &&
    (settings.readNotes === true) !== (before.readNotes === true);
  const stale = db.transaction((tx) => {
    library.setBookSettings(tx, bookId, settings);
    if (settings.pacing === undefined && !notesMoved) return [];
    const book = library.getBook(tx, bookId);
    const pacing = pacingOrDefault(book?.pacing);
    const stale = stalePauses(tx, bookId, pacingOrDefault(before.pacing), pacing);
    for (const ch of library.listChapters(tx, bookId)) {
      if (ch.narration === "none") continue;
      if (notesMoved || stale.some((r) => r.chapterId === ch.id)) {
        if (!narrationInProgress(tx, bookId, ch.id)) settleChapter(tx, bookId, ch.id);
      } else {
        const segs = readScript(tx, bookId, ch.id);
        library.setChapterDuration(tx, bookId, ch.id, chapterSeconds(segs, pacing, book));
      }
    }
    return stale;
  });
  return { ...bookWithChapters(db, bookId), stale };
}

/**
 * Mark stale every rendered clip holding a book-length pause whose length changed. A pause with its
 * own length, or omitted, is unaffected.
 */
function stalePauses(tx: Tx, bookId: string, before: Pacing, after: Pacing): RevisedLines[] {
  const moved = new Set([
    ...(before.inlineShort !== after.inlineShort ? ["pause"] : []),
    ...(before.inlineLong !== after.inlineLong ? ["long pause"] : []),
  ]);
  if (!moved.size) return [];
  const stale: RevisedLines[] = [];
  for (const chapterId of library.chapterIds(tx, bookId)) {
    const ids: number[] = [];
    for (const s of readScript(tx, bookId, chapterId)) {
      if (s.audio.status !== "done") continue;
      const held = s.expressions?.some(
        (a) => a.kind === "pause" && !a.omitted && a.seconds == null && moved.has(a.id),
      );
      if (!held) continue;
      writeClip(tx, bookId, chapterId, s.id, "current", { ...s.audio, status: "stale" });
      ids.push(s.id);
    }
    if (ids.length) stale.push({ chapterId, ids, revision: bumpRevision(tx, bookId, chapterId) });
  }
  return stale;
}

export function renameVolume(db: Db, bookId: string, volumeId: number, name: string): Book {
  const book = requireBook(db, bookId);
  if (!book.volumes.some((x) => x.id === volumeId)) throw notFound("No such volume");
  library.renameVolume(db, bookId, volumeId, name);
  return requireBook(db, bookId);
}

/**
 * Cut the book into volumes by where each begins. Refused mid-build (a build files each chapter
 * under its volume) and while a shelved book's volume is in review (the review takes it whole).
 */
export function setVolumes(db: Db, bookId: string, starts: readonly VolumeStart[]): ImportedBook {
  const book = requireBook(db, bookId);
  const ids = new Set(library.listChapters(db, bookId).map((c) => c.id));
  const first = Math.min(...ids);
  if (
    !starts.length ||
    starts[0].chapter !== first ||
    starts.some((s, i) => !ids.has(s.chapter) || (i > 0 && s.chapter <= starts[i - 1].chapter))
  )
    throw badRequest(
      "Name where each volume begins, in reading order, the first at the book's first chapter",
      `chapters: ${first}–${Math.max(...ids)}`,
    );
  if (starts.some((s) => !s.name.trim())) throw badRequest("Every volume needs a name");
  if (!book.importing && book.volumes.some((x) => x.importing))
    throw conflict(
      `A volume of “${book.title}” is still in review`,
      "Add it to the book or cancel it before cutting volumes.",
    );
  if (queue.activeJob(db, "export", bookId, null))
    throw conflict(
      `An audiobook of “${book.title}” is being built`,
      "Let the build finish, or cancel it from the Queue, before cutting volumes.",
    );
  library.setVolumes(
    db,
    bookId,
    starts.map((s) => ({ chapter: s.chapter, name: s.name.trim() })),
  );
  return bookWithChapters(db, bookId);
}

/**
 * Reorder volumes and renumber chapters. Jobs carry on (they find chapters by uid). Refused
 * mid-build and while a volume is in review.
 */
export function reorderVolumes(db: Db, bookId: string, order: readonly number[]): ImportedBook {
  const book = requireBook(db, bookId);
  const ids = book.volumes.map((x) => x.id);
  if (
    order.length !== ids.length ||
    new Set(order).size !== order.length ||
    !order.every((id) => ids.includes(id))
  )
    throw badRequest("Name every volume of the book once", `volumes: ${ids.join(", ")}`);
  if (book.volumes.some((x) => x.importing))
    throw conflict(
      `A volume of “${book.title}” is still in review`,
      "Add it to the book or cancel it before reordering.",
    );
  if (queue.activeJob(db, "export", bookId, null))
    throw conflict(
      `An audiobook of “${book.title}” is being built`,
      "Let the build finish, or cancel it from the Queue, before reordering volumes.",
    );
  if (order.every((id, i) => id === ids[i])) return bookWithChapters(db, bookId);
  library.reorderVolumes(db, bookId, order);
  return bookWithChapters(db, bookId);
}
