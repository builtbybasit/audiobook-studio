// The library over HTTP.
//
// Import → review contents → add, the same three steps the demo walks, with the review working on
// a book marked `importing` that the library does not list yet. Every route here is a request
// turned into one call on `server/library/ops.ts` and the result turned into JSON: the rules are
// there, and a refusal they raise is answered by `app.onError` in the API's one error shape.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { AudioFiles } from "~/audio/files";
import { coverFiles, MAX_COVER_BYTES } from "~/covers/files";
import type { AudiobookFiles } from "~/exports/files";
import type { Db } from "~/db/client";
import { env, importBodyBytes } from "~/env";
import { enqueueNarration } from "~/jobs/narration";
import type { Runner } from "~/jobs/runner";
import { enqueueScripting } from "~/jobs/scripting";
import { fail, notFound } from "~/lib/errors";
import { IdParam } from "~/lib/http";
import { fileResponse } from "~/lib/serve";
import { validate } from "~/lib/validate";
import * as ops from "~/library/ops";

const Ids = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});

/**
 * Chapters to script, and the scripting profile the browser has chosen — whose `maxChars` and
 * `splitAt` cut each chapter into the requests the Endpoints page previews. Absent, a chapter goes
 * whole.
 */
const ScriptIds = v.object({
  ...Ids.entries,
  profile: v.optional(v.pipe(v.string(), v.maxLength(200))),
});

/** Chapters to narrate, and which of their lines: `all` when the request does not say. */
const Narrate = v.object({
  ...Ids.entries,
  scope: v.optional(v.picklist(["fill", "failed", "all"]), "all"),
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

/** Seconds of silence: a pause nobody would sit through is a typo, not a setting. */
const Seconds = v.pipe(v.number(), v.minValue(0), v.maxValue(60));
const Dollars = v.pipe(v.number(), v.minValue(0));

/** A book's settings: a key left out is left alone, and `null` clears it. */
const Settings = v.pipe(
  v.strictObject({
    budget: v.optional(
      v.nullable(v.strictObject({ cap: v.nullable(Dollars), paused: v.boolean() })),
    ),
    scriptBudget: v.optional(v.nullable(Dollars)),
    pacing: v.optional(v.nullable(v.strictObject({ line: Seconds, turn: Seconds }))),
  }),
  v.check((s) => Object.keys(s).length > 0, "name at least one setting"),
);

const VolumeName = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
});
const VolumeOrder = v.object({
  order: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
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

const CoverForm = v.object({ file: v.instance(File) });
const CoverParam = v.object({ id: v.string(), file: v.string() });

export function bookRoutes(
  db: Db,
  runner: Runner,
  files?: AudioFiles,
  built?: AudiobookFiles,
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();
  // A book's covers are kept beside its clips, so they go when its directory does.
  const covers = files ? coverFiles(files.dir) : undefined;

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
  app.post(
    "/import",
    // Refused as the body arrives — from its `content-length` when it says, and by counting when
    // it does not — rather than after the whole of it has been buffered to be looked at. The
    // server's own ceiling (`maxRequestBodySize`) sits just above this, as a backstop that answers
    // in Bun's words; this is the one that answers in the API's.
    bodyLimit({
      maxSize: importBodyBytes(),
      onError: () =>
        fail(
          413,
          `That file is larger than the ${env.MAX_UPLOAD_MB} MB limit`,
          "Raise MAX_UPLOAD_MB if this is a file you expect to import.",
        ),
    }),
    validate("form", ImportForm),
    async (c) => {
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
        { bytes: await file.arrayBuffer(), fileName: file.name, title, bookId, name, covers },
        log,
      );
      return c.json(result, 201);
    },
  );

  // ---------- covers ----------
  if (covers) {
    /** An image for an audiobook's cover; answers with the url its settings name it by. */
    app.post(
      "/:id/covers",
      bodyLimit({
        // a little over the limit, for the multipart envelope around the image
        maxSize: MAX_COVER_BYTES + 64 * 1024,
        onError: () => fail(413, `That image is larger than ${MAX_COVER_BYTES / 1024 / 1024} MB`),
      }),
      validate("param", BookParam),
      validate("form", CoverForm),
      async (c) => {
        const bytes = new Uint8Array(await c.req.valid("form").file.arrayBuffer());
        return c.json(await ops.uploadCover(db, covers, c.req.valid("param").id, bytes), 201);
      },
    );

    /** A cover's bytes. Named by their hash, so what a url serves never changes. */
    app.get("/:id/covers/:file", validate("param", CoverParam), async (c) => {
      const { id, file } = c.req.valid("param");
      const path = covers.path(id, file);
      const found = path ? Bun.file(path) : null;
      if (!found || !(await found.exists())) throw notFound("No such cover");
      return fileResponse(c.req.raw, found, {
        "content-type": file.endsWith(".png") ? "image/png" : "image/jpeg",
        "cache-control": "private, max-age=31536000, immutable",
      });
    });
  }

  /** The review is done: the book, or its new volume, joins the library. Nothing starts running. */
  app.post("/:id/confirm", validate("param", BookParam), (c) =>
    c.json({ book: ops.confirmImport(db, c.req.valid("param").id) }),
  );

  /** Cancel an import: a book never added goes entirely; a new volume comes off its book. */
  app.post("/:id/discard", validate("param", BookParam), (c) =>
    c.json(ops.discardImport(db, c.req.valid("param").id)),
  );

  // ---------- a book's settings, and its volumes ----------
  /** The budget, the script budget and the pacing; answers with the book and its re-timed chapters. */
  app.patch("/:id", validate("param", BookParam), validate("json", Settings), (c) =>
    c.json(ops.updateBook(db, c.req.valid("param").id, c.req.valid("json"))),
  );

  /** Read the volumes in this order; the chapters are numbered to follow it. */
  app.put("/:id/volumes/order", validate("param", BookParam), validate("json", VolumeOrder), (c) =>
    c.json(ops.reorderVolumes(db, c.req.valid("param").id, c.req.valid("json").order)),
  );

  app.patch(
    "/:id/volumes/:volumeId",
    validate("param", VolumeParam),
    validate("json", VolumeName),
    (c) => {
      const { id, volumeId } = c.req.valid("param");
      return c.json({ book: ops.renameVolume(db, id, volumeId, c.req.valid("json").name) });
    },
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
  app.post(
    "/:id/chapters/script",
    validate("param", BookParam),
    validate("json", ScriptIds),
    (c) => {
      const { ids, profile } = c.req.valid("json");
      const result = enqueueScripting(db, runner, c.req.valid("param").id, ids, {
        provider: env.SCRIPTING_PROVIDER,
        profile,
      });
      c.var.logger.info(
        { run: result.runId, jobs: result.jobs.length, skipped: result.skipped.length },
        "scripting queued",
      );
      return c.json(
        { ...result, chapters: ops.bookWithChapters(db, c.req.valid("param").id).chapters },
        202,
      );
    },
  );

  // ---------- narration ----------
  /**
   * Narrate these chapters at one scope: one job each, as one run. The same answer as scripting —
   * the jobs, and the chapters left out and why — with the reasons narration adds: a chapter with
   * no script yet, and one the scope finds nothing to do in.
   */
  app.post(
    "/:id/chapters/narrate",
    validate("param", BookParam),
    validate("json", Narrate),
    (c) => {
      const { ids, scope } = c.req.valid("json");
      const result = enqueueNarration(db, runner, c.req.valid("param").id, ids, { scope });
      c.var.logger.info(
        { run: result.runId, scope, jobs: result.jobs.length, skipped: result.skipped.length },
        "narration queued",
      );
      return c.json(
        { ...result, chapters: ops.bookWithChapters(db, c.req.valid("param").id).chapters },
        202,
      );
    },
  );

  // ---------- removal ----------
  app.delete("/:id", validate("param", BookParam), async (c) => {
    const { id } = c.req.valid("param");
    await ops.removeBook(db, id, { runner, files, built });
    return c.json({ removed: id });
  });

  app.delete("/:id/volumes/:volumeId", validate("param", VolumeParam), async (c) => {
    const { id, volumeId } = c.req.valid("param");
    // the last volume going takes the book with it, files and all; see `removeVolume` for the rest
    return c.json(await ops.removeVolume(db, id, volumeId, { runner, files, built }));
  });

  return app;
}
