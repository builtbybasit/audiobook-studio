// A book's cast and pronunciation dictionary over HTTP; the rules are in `server/cast/ops.ts`.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type {
  Cast,
  LexiconSaved,
  MovedLines,
  MovedSpeakers,
  NarrationQueued,
  OldVoice,
} from "@/types";
import type { Db } from "~/db/client";
import { oldVoice, revoice } from "~/cast/oldVoice";
import * as ops from "~/cast/ops";
import type { Runner } from "~/jobs/runner";
import { BookParam } from "~/lib/http";
import { CharacterSchema, ChapterLinesSchema, LexEntrySchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";

const NameParam = v.object({ id: v.string(), name: v.pipe(v.string(), v.nonEmpty()) });
const Rename = v.object({ to: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")) });
const Name = v.pipe(v.string(), v.nonEmpty("must name a speaker"));
const Merge = v.object({
  merges: v.pipe(v.array(v.object({ from: Name, into: Name })), v.minLength(1)),
});
const Remove = v.object({ names: v.pipe(v.array(Name), v.minLength(1)) });
const Attribute = v.object({
  speakers: v.array(v.object({ character: CharacterSchema, lines: v.array(ChapterLinesSchema) })),
});
const Revoice = v.object({
  chapters: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});
const Lexicon = v.object({
  entries: v.array(LexEntrySchema),
  /** the lines an earlier change staled, which an Undo asks to have back */
  restore: v.optional(v.array(ChapterLinesSchema)),
});

export function castRoutes(db: Db, runner: Runner): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/:id/cast", validate("param", BookParam), (c) =>
    c.json(ops.bookCast(db, c.req.valid("param").id) satisfies Cast),
  );

  /** New or replaced. */
  app.put(
    "/:id/characters/:name",
    validate("param", NameParam),
    validate("json", CharacterSchema),
    (c) => {
      const { id, name } = c.req.valid("param");
      return c.json({ characters: ops.putCharacter(db, id, name, c.req.valid("json")) });
    },
  );

  app.post(
    "/:id/characters/:name/rename",
    validate("param", NameParam),
    validate("json", Rename),
    (c) => {
      const { id, name } = c.req.valid("param");
      const result = ops.renameCharacter(db, id, name, c.req.valid("json").to);
      c.var.logger.info({ from: name, chapters: result.moved.length }, "speaker renamed");
      return c.json(result satisfies MovedLines);
    },
  );

  app.post("/:id/characters/merge", validate("param", BookParam), validate("json", Merge), (c) => {
    const { merges } = c.req.valid("json");
    const result = ops.mergeCharacters(db, c.req.valid("param").id, merges);
    c.var.logger.info({ speakers: merges.length }, "speakers merged");
    return c.json(result satisfies MovedSpeakers);
  });

  app.post(
    "/:id/characters/remove",
    validate("param", BookParam),
    validate("json", Remove),
    (c) => {
      const { names } = c.req.valid("json");
      const result = ops.removeCharacters(db, c.req.valid("param").id, names);
      c.var.logger.info({ speakers: names.length }, "speakers removed");
      return c.json(result satisfies MovedSpeakers);
    },
  );

  /** What an Undo of a merge or a removal sends. */
  app.post(
    "/:id/characters/attribute",
    validate("param", BookParam),
    validate("json", Attribute),
    (c) =>
      c.json(
        ops.attribute(
          db,
          c.req.valid("param").id,
          c.req.valid("json").speakers,
        ) satisfies MovedSpeakers,
      ),
  );

  app.get("/:id/characters/:name/old-voice", validate("param", NameParam), (c) => {
    const { id, name } = c.req.valid("param");
    return c.json(oldVoice(db, id, name) satisfies OldVoice);
  });

  /** Re-narrates the old-voice lines in these chapters; chapters with none are skipped. */
  app.post(
    "/:id/characters/:name/revoice",
    validate("param", NameParam),
    validate("json", Revoice),
    (c) => {
      const { id, name } = c.req.valid("param");
      const result = revoice(db, runner, id, name, c.req.valid("json").chapters);
      c.var.logger.info(
        { run: result.runId, jobs: result.jobs.length, skipped: result.skipped.length },
        "old-voice lines queued",
      );
      return c.json(result satisfies NarrationQueued, 202);
    },
  );

  app.put("/:id/lexicon", validate("param", BookParam), validate("json", Lexicon), (c) => {
    const { entries, restore } = c.req.valid("json");
    return c.json(
      ops.putLexicon(db, c.req.valid("param").id, entries, restore) satisfies LexiconSaved,
    );
  });

  return app;
}
