// A chapter's script, history and retakes over HTTP. The revision and history rules are in
// `server/script/ops.ts`; retakes are `server/narration/ops.ts`. A flag names no revision.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type {
  ChapterHeard,
  ChapterScript,
  EditedScript,
  Flagged,
  Judged,
  RetakesQueued,
} from "@/types";
import type { Db } from "~/db/client";
import { chapterHeard } from "~/jobs/transcribe";
import type { Runner } from "~/jobs/runner";
import { BookParam, ChapterIds, IdParam } from "~/lib/http";
import { SegmentSchema, VersionOriginSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";
import * as narration from "~/narration/ops";
import * as ops from "~/script/ops";

const ChapterParam = v.object({ id: v.string(), chapterId: IdParam });
const VersionParam = v.object({ id: v.string(), chapterId: IdParam, versionId: IdParam });
const LineParam = v.object({ id: v.string(), chapterId: IdParam, segmentId: IdParam });
const Edit = v.object({
  segments: v.array(SegmentSchema),
  ifRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.optional(VersionOriginSchema),
  /** the chapter's recap, written with the script (an import carries one) */
  recap: v.optional(v.string()),
});
const Checkpoint = v.object({
  name: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")),
});
const Retakes = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});
const Verdict = v.object({ verdict: v.picklist(["accept", "reject"]) });
/** What is wrong with a line's clip, in the listener's words. */
const Flag = v.object({
  kind: v.picklist(["pronunciation", "delivery", "pause", "other"]),
  note: v.optional(v.string(), ""),
});

export function scriptRoutes(db: Db, runner: Runner): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  /** The script and the revision a later write has to name. */
  app.get("/:id/chapters/:chapterId/script", validate("param", ChapterParam), (c) => {
    const { id, chapterId } = c.req.valid("param");
    return c.json(ops.chapterScript(db, id, chapterId) satisfies ChapterScript);
  });

  /** `{ scripts: { [chapter]: { segments, revision } } }`; a chapter not in the book is left out. */
  app.get(
    "/:id/scripts",
    validate("param", BookParam),
    validate("query", v.object({ id: ChapterIds })),
    (c) => {
      const scripts = ops.chapterScripts(db, c.req.valid("param").id, c.req.valid("query").id);
      return c.json({ scripts } satisfies { scripts: Record<number, ChapterScript> });
    },
  );

  /** Replace the script, naming the revision it was read at. */
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
      return c.json(result satisfies EditedScript);
    },
  );

  /** What a transcription heard, by line (`HeardLine`). */
  app.get("/:id/chapters/:chapterId/heard", validate("param", ChapterParam), (c) => {
    const { id, chapterId } = c.req.valid("param");
    return c.json({ lines: chapterHeard(db, id, chapterId) satisfies ChapterHeard });
  });

  app.get("/:id/chapters/:chapterId/history", validate("param", ChapterParam), (c) => {
    const { id, chapterId } = c.req.valid("param");
    return c.json({ history: ops.chapterHistory(db, id, chapterId) });
  });

  app.post(
    "/:id/chapters/:chapterId/history/checkpoints",
    validate("param", ChapterParam),
    validate("json", Checkpoint),
    (c) => {
      const { id, chapterId } = c.req.valid("param");
      return c.json(ops.saveCheckpoint(db, id, chapterId, c.req.valid("json").name), 201);
    },
  );

  /** What an Undo of a checkpoint sends. */
  app.delete(
    "/:id/chapters/:chapterId/history/versions/:versionId",
    validate("param", VersionParam),
    (c) => {
      const { id, chapterId, versionId } = c.req.valid("param");
      return c.json({ history: ops.dropVersion(db, id, chapterId, versionId) });
    },
  );

  // ---------- flags ----------
  /** Answers with the flag as written and the new revision. */
  app.put(
    "/:id/chapters/:chapterId/lines/:segmentId/flag",
    validate("param", LineParam),
    validate("json", Flag),
    (c) => {
      const { id, chapterId, segmentId } = c.req.valid("param");
      return c.json(
        ops.flagLine(db, id, chapterId, segmentId, c.req.valid("json")) satisfies Flagged,
      );
    },
  );

  app.delete(
    "/:id/chapters/:chapterId/lines/:segmentId/flag",
    validate("param", LineParam),
    (c) => {
      const { id, chapterId, segmentId } = c.req.valid("param");
      return c.json(ops.flagLine(db, id, chapterId, segmentId, null) satisfies Flagged);
    },
  );

  // ---------- retakes ----------
  /** One job; answers with it, the lines queued and skipped, and the chapters as they now stand. */
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
      return c.json(result satisfies RetakesQueued, 202);
    },
  );

  /** Answers with the line and the chapter as they now stand. */
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
      return c.json(result satisfies Judged);
    },
  );

  return app;
}
