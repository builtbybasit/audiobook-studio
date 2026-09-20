// A chapter's script, its history and its retakes over HTTP.
//
// Reading a script, editing it, naming a checkpoint and forgetting a version each turn into one
// call on `server/script/ops.ts`. The revision rule and the history rule are there; here a stale
// `ifRevision` is simply the 409 `app.onError` makes of the refusal. A retake of a line and the
// verdict on it are the two calls on `server/narration/ops.ts`, addressed under the chapter because
// a retake is something done to one line of its script.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import type { Runner } from "~/jobs/runner";
import { IdParam } from "~/lib/http";
import { SegmentSchema, VersionOriginSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";
import { bookWithChapters } from "~/library/ops";
import * as narration from "~/narration/ops";
import * as ops from "~/script/ops";

const ChapterParam = v.object({ id: v.string(), chapterId: IdParam });
const VersionParam = v.object({ id: v.string(), chapterId: IdParam, versionId: IdParam });
const LineParam = v.object({ id: v.string(), chapterId: IdParam, segmentId: IdParam });
const Edit = v.object({
  segments: v.array(SegmentSchema),
  ifRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.optional(VersionOriginSchema),
});
const Checkpoint = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
});
/** Lines to render another take of, by number. */
const Retakes = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});
const Verdict = v.object({ verdict: v.picklist(["accept", "reject"]) });

export function scriptRoutes(db: Db, runner: Runner): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  /** A chapter's script as it stands, and the revision a later write has to name. */
  app.get("/:id/chapters/:chapterId/script", validate("param", ChapterParam), (c) => {
    const { id, chapterId } = c.req.valid("param");
    return c.json(ops.chapterScript(db, id, chapterId));
  });

  /** Replace the script with what a person made of it, naming the revision they read. */
  app.put(
    "/:id/chapters/:chapterId/script",
    validate("param", ChapterParam),
    validate("json", Edit),
    (c) => {
      const { id, chapterId } = c.req.valid("param");
      const result = ops.editScript(db, id, chapterId, c.req.valid("json"));
      c.var.logger.info(
        { chapter: chapterId, lines: result.segments.length, revision: result.revision },
        "script edited",
      );
      return c.json(result);
    },
  );

  app.get("/:id/chapters/:chapterId/history", validate("param", ChapterParam), (c) => {
    const { id, chapterId } = c.req.valid("param");
    return c.json({ history: ops.chapterHistory(db, id, chapterId) });
  });

  /** Name the script as it stands and keep a copy of it. */
  app.post(
    "/:id/chapters/:chapterId/history/checkpoints",
    validate("param", ChapterParam),
    validate("json", Checkpoint),
    (c) => {
      const { id, chapterId } = c.req.valid("param");
      return c.json(ops.saveCheckpoint(db, id, chapterId, c.req.valid("json").name), 201);
    },
  );

  /** Forget one version. What an Undo of a checkpoint sends. */
  app.delete(
    "/:id/chapters/:chapterId/history/versions/:versionId",
    validate("param", VersionParam),
    (c) => {
      const { id, chapterId, versionId } = c.req.valid("param");
      return c.json({ history: ops.dropVersion(db, id, chapterId, versionId) });
    },
  );

  // ---------- retakes ----------
  /**
   * Render another take of these lines, as one job. Answers with the job, the lines it queued and
   * the ones it left out and why, and the chapters as they now stand, since the one retaken reads
   * as queued from here on.
   */
  app.post(
    "/:id/chapters/:chapterId/retakes",
    validate("param", ChapterParam),
    validate("json", Retakes),
    (c) => {
      const { id, chapterId } = c.req.valid("param");
      const result = narration.retakeLines(db, runner, id, chapterId, c.req.valid("json").ids);
      c.var.logger.info(
        {
          chapter: chapterId,
          job: result.job?.id ?? null,
          queued: result.queued.length,
          skipped: result.skipped.length,
        },
        "retakes queued",
      );
      return c.json({ ...result, chapters: bookWithChapters(db, id).chapters }, 202);
    },
  );

  /** Keep or drop a line's retake. Answers with the line and the chapter as they now stand. */
  app.post(
    "/:id/chapters/:chapterId/lines/:segmentId/verdict",
    validate("param", LineParam),
    validate("json", Verdict),
    (c) => {
      const { id, chapterId, segmentId } = c.req.valid("param");
      const { verdict } = c.req.valid("json");
      const result = narration.judgeTake(db, id, chapterId, segmentId, verdict);
      c.var.logger.info(
        { chapter: chapterId, line: segmentId, verdict, revision: result.revision },
        "retake judged",
      );
      return c.json(result);
    },
  );

  return app;
}
