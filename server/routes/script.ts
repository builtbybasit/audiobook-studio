// A chapter's script and its history over HTTP.
//
// Reading a script, editing it, naming a checkpoint and forgetting a version each turn into one
// call on `server/script/ops.ts`. The revision rule and the history rule are there; here a stale
// `ifRevision` is simply the 409 `app.onError` makes of the refusal.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import { IdParam } from "~/lib/http";
import { SegmentSchema, VersionOriginSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";
import * as ops from "~/script/ops";

const ChapterParam = v.object({ id: v.string(), chapterId: IdParam });
const VersionParam = v.object({ id: v.string(), chapterId: IdParam, versionId: IdParam });
const Edit = v.object({
  segments: v.array(SegmentSchema),
  ifRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.optional(VersionOriginSchema),
});
const Checkpoint = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
});

export function scriptRoutes(db: Db): Hono<PinoEnv> {
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

  return app;
}
