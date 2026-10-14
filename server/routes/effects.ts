// The library's voice effects and thought effect over HTTP; the rules are in
// `server/effects/ops.ts`. Preview and parse use the effect runner and answer 503 without it.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Effect, EffectUses, Step, ThoughtChoice } from "@/types";
import type { EffectRunner } from "~/audio/effects";
import { formatOfFile, type AudioFiles } from "~/audio/files";
import type { Db } from "~/db/client";
import * as ops from "~/effects/ops";
import { badRequest, fail, notFound } from "~/lib/errors";
import { ChainSchema, EffectBodySchema, EffectIdSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";

const EffectParam = v.object({ id: EffectIdSchema });
const Thoughts = v.object({ effect: EffectIdSchema });
const NewEffect = v.object({ ...EffectBodySchema.entries, after: v.optional(EffectIdSchema) });
// a speaker's effect and a thought effect are two; a few more leaves room
const Preview = v.object({
  url: v.pipe(v.string(), v.maxLength(512)),
  chains: v.pipe(v.array(ChainSchema), v.maxLength(8)),
});
// Pedalboard code worth pasting is a screenful; this is many of them
const Parse = v.object({ code: v.pipe(v.string(), v.maxLength(64 * 1024)) });

export function effectRoutes(db: Db, files: AudioFiles, effects?: EffectRunner): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  /** The runner, or a 503 that says what is missing. */
  const runner = async (): Promise<EffectRunner> => {
    if (effects && (await effects.available())) return effects;
    fail(
      503,
      "Voice effects cannot run here: they need uv (docs.astral.sh/uv) — install it and restart the server",
    );
  };

  /** A clip through unsaved `chains`, as WAV; nothing is kept. `AudioFiles.find` limits the url. */
  app.post("/preview", validate("json", Preview), async (c) => {
    const { url, chains } = c.req.valid("json");
    const run = await runner();
    const path = await files.find(url);
    const format = path && formatOfFile(path);
    if (!path || !format) throw notFound("No such audio file");
    let wav: Uint8Array;
    try {
      wav = await run.render(await Bun.file(path).bytes(), format, chains, c.req.raw.signal);
    } catch (e) {
      if (c.req.raw.signal.aborted) throw e;
      throw badRequest(`The effect could not be played: ${(e as Error).message}`);
    }
    return c.body(wav as Uint8Array<ArrayBuffer>, 200, { "content-type": "audio/wav" });
  });

  /** Pasted Pedalboard code as a chain, read and never run. */
  app.post("/parse", validate("json", Parse), async (c) => {
    const { code } = c.req.valid("json");
    const run = await runner();
    try {
      return c.json({ chain: (await run.parse(code, c.req.raw.signal)) satisfies Step[] });
    } catch (e) {
      if (c.req.raw.signal.aborted) throw e;
      throw badRequest((e as Error).message);
    }
  });

  app.get("/", (c) => c.json({ effects: ops.listEffects(db) satisfies Effect[] }));

  /** At the end, or right after `after`; an unknown `after` is a 400. */
  app.post("/", validate("json", NewEffect), (c) => {
    const { after, ...body } = c.req.valid("json");
    return c.json({ effect: ops.createEffect(db, body, after) satisfies Effect }, 201);
  });

  /** Everywhere it is chosen, across every book (`EffectUses`). */
  app.get("/:id/uses", validate("param", EffectParam), (c) =>
    c.json(ops.effectUses(db, c.req.valid("param").id) satisfies EffectUses),
  );

  /** The body is the whole effect; the id stays. */
  app.put("/:id", validate("param", EffectParam), validate("json", EffectBodySchema), (c) =>
    c.json({
      effect: ops.updateEffect(db, c.req.valid("param").id, c.req.valid("json")) satisfies Effect,
    }),
  );

  /** Every choice of it goes too. */
  app.delete("/:id", validate("param", EffectParam), (c) => {
    const { id } = c.req.valid("param");
    ops.deleteEffect(db, id);
    return c.json({ removed: id });
  });

  return app;
}

/** `<base>/settings` */
export function settingRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/thoughts", (c) => c.json({ effect: ops.libraryThoughts(db) satisfies ThoughtChoice }));

  /** An effect's id, or "none". */
  app.put("/thoughts", validate("json", Thoughts), (c) =>
    c.json({ effect: ops.setLibraryThoughts(db, c.req.valid("json").effect) }),
  );

  return app;
}
