// The library over HTTP.
//
// Import → review contents → add, the same three steps the demo walks, with the review working on
// a book marked `importing` that the library does not list yet. Every route here is a request
// turned into one call on `server/library/ops.ts` and the result turned into JSON: the rules are
// there, and a refusal they raise is answered by `app.onError` in the API's one error shape.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import { env } from "~/env";
import type { Runner } from "~/jobs/runner";
import { enqueueScripting } from "~/jobs/scripting";
import { fail } from "~/lib/errors";
import { IdParam } from "~/lib/http";
import { validate } from "~/lib/validate";
import * as ops from "~/library/ops";

const Ids = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});

/** Review decisions stated outright; see `library.setDecisions`. */
const Decisions = v.object({
  decisions: v.pipe(
    v.array(
      v.object({
        id: v.pipe(v.number(), v.integer(), v.minValue(1)),
        excluded: v.optional(v.boolean()),
        kept: v.optional(v.boolean()),
      }),
    ),
    v.minLength(1),
  ),
});

const BookParam = v.object({ id: v.string() });
const ChapterParam = v.object({ id: v.string(), chapterId: IdParam });
const VolumeParam = v.object({ id: v.string(), volumeId: IdParam });

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

export function bookRoutes(db: Db, runner: Runner): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  // ---------- reading ----------
  app.get("/", (c) => c.json({ books: ops.listBooks(db) }));

  app.get("/:id", validate("param", BookParam), (c) =>
    c.json(ops.bookWithChapters(db, c.req.valid("param").id)),
  );

  app.get(
    "/:id/chapters/:chapterId/text",
    validate("param", ChapterParam),
    validate("query", TextQuery),
    (c) => {
      const { id, chapterId } = c.req.valid("param");
      const { format } = c.req.valid("query");
      // Said in the response rather than left for the caller to remember what it asked for: the
      // two forms are the same prose and only one of them is safe to bill for.
      return c.json({ text: ops.chapterText(db, id, chapterId, format), format });
    },
  );

  // ---------- importing ----------
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

    const result = await ops.importEpub(
      db,
      { bytes: await file.arrayBuffer(), fileName: file.name, title, bookId, name },
      log,
    );
    return c.json(result, 201);
  });

  /** The review is done: the book, or its new volume, joins the library. Nothing starts running. */
  app.post("/:id/confirm", validate("param", BookParam), (c) =>
    c.json({ book: ops.confirmImport(db, c.req.valid("param").id) }),
  );

  /** Cancel an import: a book never added goes entirely; a new volume comes off its book. */
  app.post("/:id/discard", validate("param", BookParam), (c) =>
    c.json(ops.discardImport(db, c.req.valid("param").id)),
  );

  // ---------- the contents review ----------
  for (const decision of ["skip", "include", "keep"] as const)
    app.post(
      `/:id/chapters/${decision}`,
      validate("param", BookParam),
      validate("json", Ids),
      (c) =>
        c.json(ops.reviewChapters(db, c.req.valid("param").id, decision, c.req.valid("json").ids)),
    );

  /** Put decisions back exactly as they were: what an Undo of a skip or a keep sends. */
  app.post(
    "/:id/chapters/decisions",
    validate("param", BookParam),
    validate("json", Decisions),
    (c) => c.json(ops.setDecisions(db, c.req.valid("param").id, c.req.valid("json").decisions)),
  );

  // ---------- scripting ----------
  // Reading and editing a script are in `server/routes/script.ts`; queueing the work is here,
  // because a run is something the library does to its chapters.
  /**
   * Script these chapters: one job each, as one run. Answers with the jobs, and with the chapters
   * it left out and why, so the client can say so instead of waiting for work that is not coming.
   */
  app.post("/:id/chapters/script", validate("param", BookParam), validate("json", Ids), (c) => {
    const result = enqueueScripting(db, runner, c.req.valid("param").id, c.req.valid("json").ids, {
      provider: env.SCRIPTING_PROVIDER,
    });
    c.var.logger.info(
      { run: result.runId, jobs: result.jobs.length, skipped: result.skipped.length },
      "scripting queued",
    );
    return c.json(
      { ...result, chapters: ops.bookWithChapters(db, c.req.valid("param").id).chapters },
      202,
    );
  });

  // ---------- removal ----------
  app.delete("/:id", validate("param", BookParam), (c) => {
    const { id } = c.req.valid("param");
    ops.removeBook(db, id);
    return c.json({ removed: id });
  });

  app.delete("/:id/volumes/:volumeId", validate("param", VolumeParam), (c) => {
    const { id, volumeId } = c.req.valid("param");
    return c.json(ops.removeVolume(db, id, volumeId));
  });

  return app;
}
