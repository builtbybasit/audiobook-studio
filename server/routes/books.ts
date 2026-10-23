// The library over HTTP: import → review contents (on a book still `importing`) → add.
// Each route is one call on `server/library/ops.ts`, where the rules are.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type {
  BookUpdated,
  CheckQueued,
  ImportedBook,
  NarrationQueued,
  PromptTrialRequest,
  PromptTrialResult,
  ScriptingQueued,
  StaleSound,
  StartedOver,
} from "@/types";
import type { EffectRunner } from "~/audio/effects";
import type { AudioFiles } from "~/audio/files";
import { coverFiles, MAX_COVER_BYTES } from "~/covers/files";
import type { AudiobookFiles } from "~/exports/files";
import type { Db } from "~/db/client";
import { keepOldSound, staleSound } from "~/effects/ops";
import { env } from "~/env";
import { enqueueCheck } from "~/jobs/check";
import { enqueueReapply } from "~/jobs/effects";
import { enqueueNarration } from "~/jobs/narration";
import type { Runner } from "~/jobs/runner";
import { enqueueScripting } from "~/jobs/scripting";
import { fail } from "~/lib/errors";
import { BookParam, ChapterIds, IdParam, uploadLimit } from "~/lib/http";
import { AGES } from "@/lib/cast";
import { bookPromptProblems } from "@/lib/prompt";
import { DEFAULT_PACING } from "@/lib/speech";
import {
  BookPromptSchema,
  EffectIdSchema,
  ExistingScopeSchema,
  ProfilePromptSchema,
  PromptTemplateSchema,
  refusePrompt,
} from "~/lib/schemas";
import { serveFile } from "~/lib/serve";
import { validate } from "~/lib/validate";
import * as ops from "~/library/ops";
import type { ScriptingProvider } from "~/providers/scripting";
import * as scriptOps from "~/script/ops";
import { tryPrompt } from "~/script/trial";

const Ids = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});

const CheckIds = v.object({
  ...Ids.entries,
  /** every clip, including those already heard as their line reads */
  again: v.optional(v.boolean()),
});

const ScriptIds = v.object({
  ...Ids.entries,
  /** the scripting profile; its `maxChars`/`splitAt` cut each chapter. Absent, a chapter goes whole. */
  profile: v.optional(v.pipe(v.string(), v.maxLength(200))),
});

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
const VoiceRef = v.pipe(v.string(), v.nonEmpty(), v.maxLength(200));
const Voice = v.nullable(VoiceRef);
/** At most one voice per gender and age; an empty list is stored as none. */
const AgeVoices = v.pipe(
  v.array(
    v.strictObject({
      slot: v.picklist(["male", "female", "other"]),
      age: v.picklist(AGES),
      voice: VoiceRef,
    }),
  ),
  v.check(
    (ages) => new Set(ages.map((a) => `${a.slot}/${a.age}`)).size === ages.length,
    "gives one gender and age two voices",
  ),
);

/** A book's settings: a key left out is left alone, and `null` clears it. */
const Settings = v.pipe(
  v.strictObject({
    budget: v.optional(
      v.nullable(v.strictObject({ cap: v.nullable(Dollars), paused: v.boolean() })),
    ),
    scriptBudget: v.optional(v.nullable(Dollars)),
    pacing: v.optional(
      v.nullable(
        v.strictObject({
          line: Seconds,
          turn: Seconds,
          inlineShort: v.optional(Seconds, DEFAULT_PACING.inlineShort),
          inlineLong: v.optional(Seconds, DEFAULT_PACING.inlineLong),
        }),
      ),
    ),
    prompt: v.optional(v.nullable(BookPromptSchema)),
    readNotes: v.optional(v.nullable(v.boolean())),
    checkByEar: v.optional(v.nullable(v.boolean())),
    pronounceOff: v.optional(v.nullable(v.boolean())),
    exactCounts: v.optional(v.nullable(v.boolean())),
    /** an effect's id or "none"; `null` follows the library's */
    thoughts: v.optional(v.nullable(EffectIdSchema)),
    characterVoice: v.optional(
      v.nullable(
        v.pipe(
          v.strictObject({
            by: v.picklist(["one", "gender"]),
            one: Voice,
            male: Voice,
            female: Voice,
            other: Voice,
            ages: v.optional(AgeVoices),
          }),
          v.transform(({ ages, ...cv }) => (ages?.length ? { ...cv, ages } : cv)),
        ),
      ),
    ),
  }),
  v.check((s) => Object.keys(s).length > 0, "name at least one setting"),
);

const VolumeName = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
});
const VolumeStarts = v.object({
  volumes: v.pipe(
    v.array(
      v.object({
        chapter: v.pipe(v.number(), v.integer(), v.minValue(1)),
        name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
      }),
    ),
    v.minLength(1),
  ),
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
 * `markdown` is what is stored and rendered. **Anything that counts, bills or sends text to a
 * provider must ask for `plain`**: otherwise a model is charged for link addresses and table pipes,
 * and a speech provider reads them out.
 */
const TextQuery = v.object({
  format: v.optional(v.picklist(["markdown", "plain"]), "markdown"),
});

/** Several chapters' prose in one read: `?id=…` repeated. */
const TextsQuery = v.object({ ...TextQuery.entries, id: ChapterIds });

// `?name=…` repeated: a query string carries one as a string and several as a list.
const MentionsQuery = v.object({
  name: v.pipe(
    v.union([v.string(), v.array(v.string())]),
    v.transform((n) =>
      [n]
        .flat()
        .map((x) => x.trim())
        .filter(Boolean),
    ),
    v.minLength(1, "must name someone"),
  ),
});

const ImportForm = v.object({
  file: v.instance(File),
  title: v.optional(v.string()),
  /** set to add this file to an existing book as one more volume */
  bookId: v.optional(v.string()),
  /** the volume's name; only read with `bookId` */
  name: v.optional(v.string()),
});

/** `cast`: whether the speakers the scripts found go too. */
const StartOver = v.object({ cast: v.optional(v.boolean()) });

const CoverForm = v.object({ file: v.instance(File) });
const CoverParam = v.object({ id: v.string(), file: v.string() });

export function bookRoutes(
  db: Db,
  runner: Runner,
  files: AudioFiles | undefined,
  built: AudiobookFiles | undefined,
  /** what a prompt trial is sent to; a test passes its own */
  scripting: ScriptingProvider,
  effects?: EffectRunner,
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
      // Echoed back: only one of the two forms is safe to bill for.
      return c.json({ text: ops.chapterText(db, id, chapterId, format), format });
    },
  );

  /**
   * `{ texts: { [chapter]: text }, format }`, for pages that read hundreds of chapters (a browser
   * cannot hold that many requests open). A chapter the book does not have is left out.
   */
  app.get("/:id/texts", validate("param", BookParam), validate("query", TextsQuery), (c) => {
    const { id: chapterIds, format } = c.req.valid("query");
    return c.json({
      texts: ops.chapterTexts(db, c.req.valid("param").id, chapterIds, format),
      format,
    });
  });

  /** For each name, the chapters whose text names it as written: `{ byName: { name: [ids] } }`. */
  app.get("/:id/mentions", validate("param", BookParam), validate("query", MentionsQuery), (c) =>
    c.json({
      byName: ops.chaptersMentioning(db, c.req.valid("param").id, c.req.valid("query").name),
    }),
  );

  // ---------- importing ----------
  const importLimit = uploadLimit(env.MAX_UPLOAD_MB, "MAX_UPLOAD_MB");
  app.post("/import", importLimit.body, validate("form", ImportForm), async (c) => {
    const { file, title, bookId, name } = c.req.valid("form");
    importLimit.file(file);
    if (!file.size) fail(400, "That file is empty");

    // `assign` also puts these on the request's summary line.
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
    /** An audiobook cover; answers with its url. */
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

    /** The book's own cover (shelf and overview); answers with the book. */
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

    /** Named by hash, so a url's bytes never change. */
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

  /** The book, or its new volume, joins the library. Nothing starts running. */
  app.post("/:id/confirm", validate("param", BookParam), (c) =>
    c.json({ book: ops.confirmImport(db, c.req.valid("param").id) }),
  );

  /** Cancel an import: a new book goes entirely; a new volume comes off its book. */
  app.post("/:id/discard", validate("param", BookParam), async (c) =>
    c.json(await ops.discardImport(db, c.req.valid("param").id, { runner, files, built })),
  );

  // ---------- a book's settings, and its volumes ----------
  /** Answers with the book and its re-settled chapters. */
  app.patch("/:id", validate("param", BookParam), validate("json", Settings), (c) => {
    const settings = c.req.valid("json");
    if (settings.prompt) refusePrompt("The book's prompt", bookPromptProblems(settings.prompt));
    return c.json(ops.updateBook(db, c.req.valid("param").id, settings) satisfies BookUpdated);
  });

  app.put("/:id/volumes", validate("param", BookParam), validate("json", VolumeStarts), (c) =>
    c.json(
      ops.setVolumes(
        db,
        c.req.valid("param").id,
        c.req.valid("json").volumes,
      ) satisfies ImportedBook,
    ),
  );

  /** The chapters are renumbered to follow the new order. */
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

  /** What an Undo of a skip or a keep sends. */
  app.post(
    "/:id/chapters/decisions",
    validate("param", BookParam),
    validate("json", Decisions),
    (c) => c.json(ops.setDecisions(db, c.req.valid("param").id, c.req.valid("json").decisions)),
  );

  // ---------- scripting ----------
  // Reading and editing a script are in `server/routes/script.ts`.
  /** One job per chapter, as one run; answers with the jobs and the chapters skipped and why. */
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
   * Try draft prompts on one chunk; the answer is shown, not written. A refused answer is a 200
   * with `error`; an unaffordable request is a 409 before it goes. Closing the request cancels it.
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
  /** One job per chapter, as one run; answers like scripting does. */
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
  /** Uses the first transcription endpoint switched on; 400 when none is. */
  app.post("/:id/chapters/check", validate("param", BookParam), validate("json", CheckIds), (c) => {
    const { ids, again } = c.req.valid("json");
    const result = enqueueCheck(db, runner, c.req.valid("param").id, ids, { again });
    c.var.logger.info(
      { run: result.runId, jobs: result.jobs.length, skipped: result.skipped.length },
      "check queued",
    );
    return c.json(result satisfies CheckQueued, 202);
  });

  // ---------- voice effects ----------
  /** How many clips have an old sound, and whether effects can run to redo them. */
  app.get(
    "/:id/effects/stale",
    validate("param", BookParam),
    validate("query", v.object({ speaker: v.optional(v.string()) })),
    async (c) =>
      c.json(
        (await staleSound(
          db,
          c.req.valid("param").id,
          c.req.valid("query"),
          effects,
        )) satisfies StaleSound,
      ),
  );

  /** 409 while a Re-apply is queued or running; no body = the whole book. */
  app.post(
    "/:id/effects/reapply",
    validate("param", BookParam),
    validate("json", ExistingScopeSchema),
    (c) => {
      const job = enqueueReapply(db, runner, c.req.valid("param").id, c.req.valid("json"));
      return c.json({ job }, 202);
    },
  );

  /** "Keep old sound": the stale clips in scope stop counting until their effects change again. */
  app.post(
    "/:id/effects/keep",
    validate("param", BookParam),
    validate("json", ExistingScopeSchema),
    (c) => c.json({ kept: keepOldSound(db, c.req.valid("param").id, c.req.valid("json")) }),
  );

  // ---------- removal ----------
  /** Scripts, clips and statuses go (kept in each chapter's history). */
  app.post("/:id/start-over", validate("param", BookParam), validate("json", StartOver), (c) => {
    const { id } = c.req.valid("param");
    const result = scriptOps.startOver(db, id, c.req.valid("json"), files);
    c.var.logger.info({ book: id, ...result.cleared }, "book started over");
    return c.json(result satisfies StartedOver);
  });

  app.delete("/:id", validate("param", BookParam), async (c) => {
    const { id } = c.req.valid("param");
    await ops.removeBook(db, id, { runner, files, built });
    return c.json({ removed: id });
  });

  app.delete("/:id/volumes/:volumeId", validate("param", VolumeParam), async (c) => {
    const { id, volumeId } = c.req.valid("param");
    // the last volume going takes the book with it
    return c.json(await ops.removeVolume(db, id, volumeId, { runner, files, built }));
  });

  return app;
}
