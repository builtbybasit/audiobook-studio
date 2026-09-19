// A book's cast and pronunciation dictionary over HTTP. Every route is one call on
// `server/cast/ops.ts`; the rules — and the lines a rename moves — are there.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import * as ops from "~/cast/ops";
import { CharacterSchema, ChapterLinesSchema, LexEntrySchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";

const BookParam = v.object({ id: v.string() });
const NameParam = v.object({ id: v.string(), name: v.pipe(v.string(), v.nonEmpty()) });
const Rename = v.object({ to: v.pipe(v.string(), v.trim(), v.nonEmpty("must not be empty")) });
const Merge = v.object({ into: v.pipe(v.string(), v.nonEmpty("must name a speaker")) });
const Attribute = v.object({ character: CharacterSchema, lines: v.array(ChapterLinesSchema) });
const Lexicon = v.object({ entries: v.array(LexEntrySchema) });

export function castRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/:id/cast", validate("param", BookParam), (c) =>
    c.json(ops.bookCast(db, c.req.valid("param").id)),
  );

  /** One speaker, written as stated: new or replaced. */
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
      return c.json(result);
    },
  );

  app.post(
    "/:id/characters/:name/merge",
    validate("param", NameParam),
    validate("json", Merge),
    (c) => {
      const { id, name } = c.req.valid("param");
      const result = ops.mergeCharacter(db, id, name, c.req.valid("json").into);
      c.var.logger.info({ from: name, chapters: result.moved.length }, "speaker merged");
      return c.json(result);
    },
  );

  /** Take a speaker off the cast; their lines go to the Narrator. */
  app.delete("/:id/characters/:name", validate("param", NameParam), (c) => {
    const { id, name } = c.req.valid("param");
    return c.json(ops.deleteCharacter(db, id, name));
  });

  /** Put a speaker back on exactly these lines: what an Undo of a merge or a removal sends. */
  app.post(
    "/:id/characters/attribute",
    validate("param", BookParam),
    validate("json", Attribute),
    (c) => {
      const { character, lines } = c.req.valid("json");
      return c.json(ops.attribute(db, c.req.valid("param").id, character, lines));
    },
  );

  app.put("/:id/lexicon", validate("param", BookParam), validate("json", Lexicon), (c) =>
    c.json({ entries: ops.putLexicon(db, c.req.valid("param").id, c.req.valid("json").entries) }),
  );

  return app;
}
