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

import type {
  CheckQueued,
  ImportedBook,
  NarrationQueued,
  PromptTrialRequest,
  PromptTrialResult,
  ScriptingQueued,
} from "@/types";
import type { AudioFiles } from "~/audio/files";
import { coverFiles, MAX_COVER_BYTES } from "~/covers/files";
import type { AudiobookFiles } from "~/exports/files";
import type { Db } from "~/db/client";
import { env } from "~/env";
import { enqueueCheck } from "~/jobs/check";
import { enqueueNarration } from "~/jobs/narration";
import type { Runner } from "~/jobs/runner";
import { enqueueScripting } from "~/jobs/scripting";
import { fail } from "~/lib/errors";
import { BookParam, IdParam, uploadLimit } from "~/lib/http";
import { bookPromptProblems } from "@/lib/prompt";
import {
  BookPromptSchema,
  ProfilePromptSchema,
  PromptTemplateSchema,
  refusePrompt,
} from "~/lib/schemas";
import { serveFile } from "~/lib/serve";
import { validate } from "~/lib/validate";
import * as ops from "~/library/ops";
import type { ScriptingProvider } from "~/providers/scripting";
import { tryPrompt } from "~/script/trial";

const Ids = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});

/**
 * Chapters to script, and the scripting profile the browser has chosen — whose `maxChars` and
 * `splitAt` cut each chapter into the requests the Endpoints page previews. Absent, a chapter goes
 * whole.
 */
const CheckIds = v.object({
  ...Ids.entries,
  /** every clip, those already heard as their line reads too */
  again: v.optional(v.boolean()),
});

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
/** A voice as `<endpointId>/<voiceId>`, or none. */
const Voice = v.nullable(v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)));

/** A book's settings: a key left out is left alone, and `null` clears it. */
const Settings = v.pipe(
  v.strictObject({
    budget: v.optional(
      v.nullable(v.strictObject({ cap: v.nullable(Dollars), paused: v.boolean() })),
    ),
    scriptBudget: v.optional(v.nullable(Dollars)),
    pacing: v.optional(v.nullable(v.strictObject({ line: Seconds, turn: Seconds }))),
    prompt: v.optional(v.nullable(BookPromptSchema)),
    readNotes: v.optional(v.nullable(v.boolean())),
    checkByEar: v.optional(v.nullable(v.boolean())),
    plainThoughts: v.optional(v.nullable(v.boolean())),
    characterVoice: v.optional(
      v.nullable(
        v.strictObject({
          by: v.picklist(["one", "gender"]),
          one: Voice,
          male: Voice,
          female: Voice,
          other: Voice,
        }),
      ),
    ),
  }),
  v.check((s) => Object.keys(s).length > 0, "name at least one setting"),
);

const VolumeName = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
});
const VolumeOrder = v.object({
  order: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});

/** One chunk to try a prompt on, and the drafts to try; see `PromptTrialRequest`. */
const PromptTrial = v.object({
  profile: v.pipe(v.string(), v.nonEmpty("must not be empty"), v.maxLength(200)),
  chapterId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  part: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  library: v.optional(v.nullable(PromptTemplateSchema)),
  profilePrompt: v.optional(v.nullable(ProfilePromptSchema)),
  book: v.optional(v.nullable(BookPromptSchema)),
}) satisfies v.GenericSchema<unknown, PromptTrialRequest>;

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
  files: AudioFiles | undefined,
  built: AudiobookFiles | undefined,
  /** what a prompt trial is sent to: the app's own, so a test's stands in for the network */
  scripting: ScriptingProvider,
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();
  // A book's covers are kept beside its clips, so they go when its directory does.
  const covers = files ? coverFiles(files) : undefined;

  // ---------- reading ----------
  app.get("/", (c) => c.json({ books: ops.listBooks(db) }));

  app.get("/:id", validate("param", BookParam), (c) =>
    c.json(ops.bookWithChapters(db, c.req.valid("param").id) satisfies ImportedBook),
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
  const importLimit = uploadLimit(env.MAX_UPLOAD_MB, "MAX_UPLOAD_MB");
  app.post("/import", importLimit.body, validate("form", ImportForm), async (c) => {
    const { file, title, bookId, name } = c.req.valid("form");
    importLimit.file(file);
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
    return c.json(result satisfies ImportedBook, 201);
  });

  // ---------- covers ----------
  if (covers) {
    const coverLimit = bodyLimit({
      // a little over the limit, for the multipart envelope around the image
      maxSize: MAX_COVER_BYTES + 64 * 1024,
      onError: () => fail(413, `That image is larger than ${MAX_COVER_BYTES / 1024 / 1024} MB`),
    });
    /** An image for an audiobook's cover; answers with the url its settings name it by. */
    app.post(
      "/:id/covers",
      coverLimit,
      validate("param", BookParam),
      validate("form", CoverForm),
      async (c) => {
        const bytes = new Uint8Array(await c.req.valid("form").file.arrayBuffer());
        return c.json(await ops.uploadCover(db, covers, c.req.valid("param").id, bytes), 201);
      },
    );

    /** An image for the book's own cover, the shelf's and the overview's; answers with the book. */
    app.post(
      "/:id/cover",
      coverLimit,
      validate("param", BookParam),
      validate("form", CoverForm),
      async (c) => {
        const bytes = new Uint8Array(await c.req.valid("form").file.arrayBuffer());
        return c.json({
          book: await ops.changeBookCover(db, covers, c.req.valid("param").id, bytes),
        });
      },
    );

    /** A cover's bytes. Named by their hash, so what a url serves never changes. */
    app.get("/:id/covers/:file", validate("param", CoverParam), (c) => {
      const { id, file } = c.req.valid("param");
      return serveFile(
        c,
        covers.path(id, file),
        file.endsWith(".png") ? "image/png" : "image/jpeg",
        {
          missing: "No such cover",
        },
      );
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
  /** The budget, the script budget, the pacing, the prompt, whether notes are read and whether chapters are checked by ear; answers with the book and its re-settled chapters. */
  app.patch("/:id", validate("param", BookParam), validate("json", Settings), (c) => {
    const settings = c.req.valid("json");
    if (settings.prompt) refusePrompt("The book's prompt", bookPromptProblems(settings.prompt));
    return c.json(ops.updateBook(db, c.req.valid("param").id, settings) satisfies ImportedBook);
  });

  /** Read the volumes in this order; the chapters are numbered to follow it. */
  app.put("/:id/volumes/order", validate("param", BookParam), validate("json", VolumeOrder), (c) =>
    c.json(
      ops.reorderVolumes(
        db,
        c.req.valid("param").id,
        c.req.valid("json").order,
      ) satisfies ImportedBook,
    ),
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
      const result = enqueueScripting(db, runner, c.req.valid("param").id, ids, profile);
      c.var.logger.info(
        { run: result.runId, jobs: result.jobs.length, skipped: result.skipped.length },
        "scripting queued",
      );
      return c.json(result satisfies ScriptingQueued, 202);
    },
  );

  /**
   * Try a prompt on one chunk of a chapter: the drafts sent over what is saved, and the answer
   * shown, not written. A refused answer is a result (200, with `error`); a request the book cannot
   * afford is refused (409) before it goes. Closing the request cancels it.
   */
  app.post(
    "/:id/script-trial",
    validate("param", BookParam),
    validate("json", PromptTrial),
    async (c) => {
      const body = c.req.valid("json");
      const result = await tryPrompt(
        db,
        scripting,
        c.req.valid("param").id,
        body,
        c.req.raw.signal,
      );
      c.var.logger.info(
        {
          profile: body.profile,
          chapter: body.chapterId,
          part: result.part,
          ok: result.fidelity.ok && !result.error,
        },
        "prompt tried",
      );
      return c.json(result satisfies PromptTrialResult);
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
      return c.json(result satisfies NarrationQueued, 202);
    },
  );

  // ---------- checking by ear ----------
  /**
   * Hear these chapters' clips back on the first transcription endpoint switched on: one job each,
   * as one run, and the chapters left out and why — with `again`, the clips already heard too.
   * Refused whole (400) when none is switched on.
   */
  app.post("/:id/chapters/check", validate("param", BookParam), validate("json", CheckIds), (c) => {
    const { ids, again } = c.req.valid("json");
    const result = enqueueCheck(db, runner, c.req.valid("param").id, ids, { again });
    c.var.logger.info(
      { run: result.runId, jobs: result.jobs.length, skipped: result.skipped.length },
      "check queued",
    );
    return c.json(result satisfies CheckQueued, 202);
  });

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
