// What the library does, as operations.
//
// Routes turn a request into one of these calls and its result into a response; jobs and tests
// call them directly. The rules live here — a volume goes onto a book with nothing waiting in its
// review, removing the last volume removes the book, a discard means one thing for a new book and
// another for a new volume — so there is one statement of each, and none of them knows what a
// status code is. A rule that does not hold is thrown as an `AppError`, which `app.onError` turns
// into the API's one error shape.
import type { Book, Chapter } from "@/types";
import type { AudioFiles } from "~/audio/files";
import type { AudiobookFiles } from "~/exports/files";
import type { Db } from "~/db/client";
import * as queue from "~/db/jobs";
import * as library from "~/db/library";
import { env } from "~/env";
import { checkArchive } from "~/epub/archive";
import { diagnose } from "~/epub/diagnose";
import { plainText } from "~/epub/markdown";
import { EpubParseError, parseEpub, type ParsedEpub } from "~/epub/parse";
import { assembleBook, assembleVolume } from "~/import/assemble";
import type { Runner } from "~/jobs/runner";
import { AppError, conflict, notFound } from "~/lib/errors";
import { slugify } from "~/lib/http";
import { inBackground } from "~/lib/background";

/**
 * Enough of a logger to say what an import found. The request logger `hono-pino` puts on the
 * context is not a pino `Logger`, and the import does not need one to be.
 */
export interface ImportLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface BookAndChapters {
  book: Book;
  chapters: Chapter[];
}

/** Every book, importing ones included. */
export const listBooks = (db: Db): Book[] => library.listBooks(db);

/** The book, or the refusal that says there is none. */
export function requireBook(db: Db, bookId: string): Book {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  return book;
}

export function bookWithChapters(db: Db, bookId: string): BookAndChapters {
  const book = requireBook(db, bookId);
  return { book, chapters: library.listChapters(db, book.id) };
}

/** A chapter's prose in the form asked for. See `LibraryService.chapterText` for why there are two. */
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

// ---------- importing ----------

export interface ImportInput {
  bytes: ArrayBuffer;
  /** the uploaded file's name, which becomes the volume's `file` */
  fileName: string;
  /** override the title the EPUB declares */
  title?: string;
  /** set to add this file to an existing book as one more volume */
  bookId?: string;
  /** the volume's name; only read when `bookId` is set */
  name?: string;
}

export interface Imported extends BookAndChapters {
  /** the volume the file became, when it was added to an existing book */
  volumeId?: number;
  /** what the file turned out to hold */
  read: { chapters: number; words: number; unreadable: number; ms: number };
}

/**
 * The book an uploaded volume is going onto, or the refusal that stops the upload.
 *
 * Asked twice by `importEpub`: once before the file is parsed, to refuse in milliseconds rather
 * than after the work, and once at the point of inserting, because a review could have been
 * started in between and the second ask is the one that decides.
 */
export function volumeTarget(db: Db, bookId: string): Book {
  const book = requireBook(db, bookId);
  if (book.volumes.some((vol) => vol.importing))
    throw conflict(`“${book.title}” already has a volume waiting in its contents review`);
  return book;
}

/**
 * Read an EPUB that would not parse for the reason a person can act on.
 *
 * The parser says what stopped it; EPUBCheck says what is wrong with the file. It runs only here,
 * on a failure, never as a gate — see `docs/backend.md`.
 */
async function refused(bytes: ArrayBuffer, e: EpubParseError, log?: ImportLog): Promise<never> {
  const why = await diagnose(bytes);
  log?.warn({ reason: e.message, epubcheck: why }, "refused the file");
  throw new AppError(
    415,
    "That file could not be read as an EPUB",
    [e.message, why].filter(Boolean).join(" "),
  );
}

/**
 * Read an uploaded EPUB into a book, or into one more volume of a book already in the library.
 *
 * The result is the book and its chapters exactly as the contents review needs them, so the client
 * does not have to fetch again to show what it just imported.
 */
export async function importEpub(db: Db, input: ImportInput, log?: ImportLog): Promise<Imported> {
  const { bytes, fileName, title, bookId, name } = input;

  // A volume goes onto a book that exists and has nothing already waiting in its review. Asked
  // before the file is read, because a thousand-chapter EPUB is several seconds of parsing to throw
  // away — and asked again below, since nothing holds the book still in between.
  if (bookId) volumeTarget(db, bookId);

  const started = performance.now();
  let parsed: ParsedEpub;
  try {
    // Measured before it is read: an upload is a zip, and what it unzips to is what costs memory.
    // A refusal here is a 413 and skips the diagnosis below, which would unzip it all again.
    await checkArchive(bytes, {
      total: env.MAX_UNZIPPED_MB * 1024 * 1024,
      document: env.MAX_DOCUMENT_MB * 1024 * 1024,
    });
    parsed = await parseEpub(bytes);
  } catch (e) {
    if (!(e instanceof EpubParseError)) throw e;
    return refused(bytes, e, log);
  }

  // What the file turned out to hold. `unreadable` is the count worth seeing without being asked
  // for: an import that half worked looks exactly like one that worked, from the outside.
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
  library.insertBook(db, assembled.book, assembled.chapters, assembled.bodies);
  log?.info(
    { book: id, title: assembled.book.title, chapters: assembled.chapters.length },
    "stored a new book",
  );
  return { ...bookWithChapters(db, id), read };
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

/** Cancel an import: a book never added goes entirely; a new volume comes off its book. */
export function discardImport(db: Db, bookId: string): Discarded {
  const book = requireBook(db, bookId);
  if (book.importing) {
    library.deleteBook(db, bookId);
    return { discarded: "book" };
  }
  const vol = book.volumes.find((x) => x.importing);
  if (!vol) throw conflict("Nothing is waiting in this book’s contents review");
  // A volume still in its review has had nothing run on it, so nothing on disk to remove.
  const { chapters } = library.deleteVolume(db, bookId, vol.id);
  return { discarded: "volume", volumeId: vol.id, chapters };
}

// ---------- the contents review ----------

export type ReviewDecision = "skip" | "include" | "keep";

/**
 * Skip chapters for the audiobook, put them back, or keep a noted one and stop the suggestion
 * asking. Nothing is deleted by any of the three. Returns how many chapters the decision changed,
 * and the chapters as they now stand.
 */
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

/**
 * Put chapters' review decisions to exactly these. The undo primitive: what a batch of decisions
 * changed is put back as it was, not re-derived through a rule that only runs forwards.
 */
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
 * Remove a book and everything it owns.
 *
 * Its files on disk go after the rows have — the clips it was narrated from and the audiobooks it
 * was built into, which are kept in two places and both belong to the book. A directory that
 * outlives its book is a leak, and a book whose rows outlive its files is a chapter that plays
 * nothing, so the order is the one that can only ever leave the first. The removal is not waited
 * for, because nothing that follows depends on it and a slow disk must not hold the response.
 */
export function removeBook(
  db: Db,
  bookId: string,
  files?: AudioFiles,
  built?: AudiobookFiles,
): void {
  requireBook(db, bookId);
  library.deleteBook(db, bookId);
  inBackground(files?.removeBook(bookId), "could not remove a book's clips", { book: bookId });
  inBackground(built?.removeBook(bookId), "could not remove a book's audiobooks", { book: bookId });
}

export type Removed = { removed: "book" } | { removed: "volume"; chapters: number };

/** What removing a volume reaches beyond the database: the queue, and the files on disk. */
export interface VolumePorts {
  runner?: Runner;
  files?: AudioFiles;
  built?: AudiobookFiles;
}

/**
 * Remove a volume; its chapters go and the rest are renumbered.
 *
 * Removing the last volume removes the book: a book with no chapters is not a library entry, it is
 * a row nothing can be done with.
 *
 * The rest is the demo's rule, kept on the server. Work queued or running on the chapters that go
 * is cancelled first, so a provider stops being paid for lines nobody will hear; work on the
 * chapters that stay carries on under their new numbers. An audiobook keeps the chapters it still
 * has and one left with none goes. The clips those chapters rendered, and the files of any
 * audiobook that went, are removed from disk after the rows, without waiting.
 *
 * Refused while an audiobook of this book is being built, as removing that audiobook is: a build
 * reads its chapters' clips and records where each landed by chapter number, and both are what a
 * removal changes under it.
 */
export function removeVolume(
  db: Db,
  bookId: string,
  volumeId: number,
  { runner, files, built }: VolumePorts = {},
): Removed {
  const book = requireBook(db, bookId);
  if (!book.volumes.some((x) => x.id === volumeId)) throw notFound("No such volume");
  if (queue.activeJob(db, "export", bookId, null))
    throw conflict(
      `An audiobook of “${book.title}” is being built`,
      "Let the build finish, or cancel it from the Queue, before removing a volume.",
    );
  if (book.volumes.length <= 1) {
    removeBook(db, bookId, files, built);
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
