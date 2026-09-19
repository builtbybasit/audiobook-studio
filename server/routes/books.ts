// The library over HTTP.
//
// Import → review contents → add, the same three steps the demo walks, with the review working on
// a book marked `importing` that the library does not list yet. Nothing here starts a job or
// contacts a provider: this slice reads EPUBs and stores books.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Book } from "@/types";
import type { Db } from "~/db/client";
import { env } from "~/env";
import { diagnose } from "~/epub/diagnose";
import { plainText } from "~/epub/markdown";
import { EpubParseError, parseEpub } from "~/epub/parse";
import { assembleBook, assembleVolume } from "~/import/assemble";
import { fail, slugify } from "~/lib/http";
import { validate } from "~/lib/validate";
import * as library from "~/db/library";

const Ids = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer())), v.minLength(1)),
});

/**
 * Which form of a chapter's prose is wanted.
 *
 * `markdown` is what is stored and what the contents review renders: headings, emphasis and the
 * tables a chapter was laid out in. `plain` is that with the Markdown resolved away, and is what
 * **anything that counts, bills or sends the text to a provider must ask for** — a model given the
 * stored form would be charged for a link's address and a table's pipes, and a speech provider
 * would read them out.
 */
const TextQuery = v.object({
  format: v.optional(v.picklist(["markdown", "plain"]), "markdown"),
});

const ImportForm = v.object({
  file: v.instance(File),
  /** override the title the EPUB declares */
  title: v.optional(v.string()),
  /** set to add this file to an existing book as one more volume */
  bookId: v.optional(v.string()),
  /** the volume's name; only read when `bookId` is set */
  name: v.optional(v.string()),
});

/**
 * The book an uploaded volume is going onto, or the refusal that stops the upload.
 *
 * Its own function because the import asks twice: once before it parses the file, to refuse in
 * milliseconds rather than after the work, and once at the point of inserting, because a review
 * could have been started in between and the second ask is the one that decides.
 */
function volumeTarget(db: Db, bookId: string): Book {
  const book = library.getBook(db, bookId);
  if (!book) fail(404, "No such book");
  if (book.volumes.some((vol) => vol.importing))
    fail(409, `“${book.title}” already has a volume waiting in its contents review`);
  return book;
}

export function bookRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  // ---------- reading ----------
  app.get("/", (c) => c.json({ books: library.listBooks(db) }));

  app.get("/:id", (c) => {
    const book = library.getBook(db, c.req.param("id"));
    if (!book) fail(404, "No such book");
    return c.json({ book, chapters: library.listChapters(db, book.id) });
  });

  app.get("/:id/chapters/:chapterId/text", validate("query", TextQuery), (c) => {
    const chapterId = Number(c.req.param("chapterId"));
    if (!Number.isInteger(chapterId)) fail(400, "Chapter number must be a whole number");
    const body = library.getChapterBody(db, c.req.param("id"), chapterId);
    if (body == null) fail(404, "No such chapter");
    const { format } = c.req.valid("query");
    // Said in the response rather than left for the caller to remember what it asked for: the two
    // forms are the same prose and only one of them is safe to bill for.
    return c.json({ text: format === "plain" ? plainText(body) : body, format });
  });

  // ---------- importing ----------
  /**
   * Read an uploaded EPUB into a book, or into one more volume of a book already in the library.
   *
   * The response is the book and its chapters exactly as the contents review needs them, so the
   * client does not have to fetch again to show what it just imported.
   */
  app.post("/import", validate("form", ImportForm), async (c) => {
    const { file, title, bookId, name } = c.req.valid("form");

    const limit = env.MAX_UPLOAD_MB * 1024 * 1024;
    if (file.size > limit)
      fail(
        413,
        `That file is larger than the ${env.MAX_UPLOAD_MB} MB limit`,
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Raise MAX_UPLOAD_MB if this is a file you expect to import.`,
      );
    if (!file.size) fail(400, "That file is empty");

    // `assign` puts these on the request's own line too, so the one-line summary of the request
    // and anything written during it agree about which file they are talking about.
    const log = c.var.logger;
    log.assign({ name: "import", file: file.name, bytes: file.size });

    // A volume goes onto a book that exists and has nothing already waiting in its review. Asked
    // before the file is read, because a thousand-chapter EPUB is several seconds of parsing to
    // throw away — and asked again below, since nothing holds the book still in between.
    if (bookId) volumeTarget(db, bookId);

    const started = performance.now();

    const bytes = await file.arrayBuffer();
    let parsed;
    try {
      parsed = await parseEpub(bytes);
    } catch (e) {
      if (!(e instanceof EpubParseError)) throw e;
      // The parser says what stopped it; the validator says what is wrong with the file. Somebody
      // holding a book that will not import can act on the second and not on the first.
      const why = await diagnose(bytes);
      log.warn({ reason: e.message, epubcheck: why }, "refused the file");
      fail(
        415,
        "That file could not be read as an EPUB",
        [e.message, why].filter(Boolean).join(" "),
      );
    }

    // What the file turned out to hold. `unreadable` is the count worth seeing without being asked
    // for: an import that half worked looks exactly like one that worked, from the outside.
    const unreadable = parsed.chapters.filter((ch) => ch.unreadable).length;
    const read = {
      chapters: parsed.chapters.length,
      words: parsed.chapters.reduce((n, ch) => n + ch.words, 0),
      ms: Math.round(performance.now() - started),
    };
    if (unreadable) log.warn({ ...read, unreadable }, "some chapters could not be read");
    else log.info(read, "read the file");

    // ---- one more volume of an existing book ----
    if (bookId) {
      const book = volumeTarget(db, bookId);

      const { volume, chapters, bodies } = assembleVolume(
        parsed.chapters,
        library.lastVolumeId(db, bookId) + 1,
        library.lastChapterNumber(db, bookId) + 1,
        {
          name: name?.trim() || `Vol. ${book.volumes.length + 1}`,
          file: file.name,
        },
      );
      library.insertVolume(db, bookId, volume, chapters, bodies);
      log.info({ book: bookId, volume: volume.id, chapters: chapters.length }, "added a volume");
      return c.json(
        {
          book: library.getBook(db, bookId),
          chapters: library.listChapters(db, bookId),
          volumeId: volume.id,
        },
        201,
      );
    }

    // ---- a new book ----
    const id = library.freeBookId(db, slugify(title?.trim() || parsed.title || file.name));
    const assembled = assembleBook(parsed, id, file.name, { title });
    library.insertBook(db, assembled.book, assembled.chapters, assembled.bodies);
    log.info(
      { book: id, title: assembled.book.title, chapters: assembled.chapters.length },
      "stored a new book",
    );
    return c.json({ book: library.getBook(db, id), chapters: library.listChapters(db, id) }, 201);
  });

  /** The review is done: the book, or its new volume, joins the library. Nothing starts running. */
  app.post("/:id/confirm", (c) => {
    const id = c.req.param("id");
    if (!library.getBook(db, id)) fail(404, "No such book");
    library.confirmImport(db, id);
    return c.json({ book: library.getBook(db, id) });
  });

  /** Cancel an import: a book never added goes entirely; a new volume comes off its book. */
  app.post("/:id/discard", (c) => {
    const id = c.req.param("id");
    const book = library.getBook(db, id);
    if (!book) fail(404, "No such book");
    if (book.importing) {
      library.deleteBook(db, id);
      return c.json({ discarded: "book" as const });
    }
    const vol = book.volumes.find((x) => x.importing);
    if (!vol) fail(409, "Nothing is waiting in this book’s contents review");
    const chapters = library.deleteVolume(db, id, vol.id);
    return c.json({ discarded: "volume" as const, volumeId: vol.id, chapters });
  });

  // ---------- the contents review ----------
  app.post("/:id/chapters/skip", validate("json", Ids), (c) => {
    const id = c.req.param("id");
    if (!library.getBook(db, id)) fail(404, "No such book");
    const changed = library.setSkipped(db, id, c.req.valid("json").ids, true);
    return c.json({ changed, chapters: library.listChapters(db, id) });
  });

  app.post("/:id/chapters/include", validate("json", Ids), (c) => {
    const id = c.req.param("id");
    if (!library.getBook(db, id)) fail(404, "No such book");
    const changed = library.setSkipped(db, id, c.req.valid("json").ids, false);
    return c.json({ changed, chapters: library.listChapters(db, id) });
  });

  app.post("/:id/chapters/keep", validate("json", Ids), (c) => {
    const id = c.req.param("id");
    if (!library.getBook(db, id)) fail(404, "No such book");
    const changed = library.setKept(db, id, c.req.valid("json").ids);
    return c.json({ changed, chapters: library.listChapters(db, id) });
  });

  // ---------- removal ----------
  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!library.getBook(db, id)) fail(404, "No such book");
    library.deleteBook(db, id);
    return c.json({ removed: id });
  });

  app.delete("/:id/volumes/:volumeId", (c) => {
    const id = c.req.param("id");
    const volumeId = Number(c.req.param("volumeId"));
    const book = library.getBook(db, id);
    if (!book) fail(404, "No such book");
    if (!book.volumes.some((x) => x.id === volumeId)) fail(404, "No such volume");
    // Removing the last volume removes the book: a book with no chapters is not a library entry,
    // it is a row nothing can be done with.
    if (book.volumes.length <= 1) {
      library.deleteBook(db, id);
      return c.json({ removed: "book" as const });
    }
    const chapters = library.deleteVolume(db, id, volumeId);
    return c.json({ removed: "volume" as const, chapters });
  });

  return app;
}
