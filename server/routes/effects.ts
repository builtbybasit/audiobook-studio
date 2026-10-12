// The library's voice effects over HTTP, and its thought effect. Both belong to the installation
// rather than to a book; every CRUD route is one call on `server/effects/ops.ts`.
//
// Two routes run the effect runner rather than the database: a preview, which plays a clip already
// on disk through chains the editor has not saved yet, and a parse, which reads pasted Pedalboard
// code into a chain. Both answer 503 where the runner cannot run, so the page can say why.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Effect, Step, ThoughtChoice } from "@/types";
import type { EffectRunner } from "~/audio/effects";
import { formatOfFile, type AudioFiles } from "~/audio/files";
import type { Db } from "~/db/client";
import * as ops from "~/effects/ops";
import { badRequest, fail, notFound } from "~/lib/errors";
import { ChainSchema, EffectBodySchema, EffectIdSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";

const EffectParam = v.object({ id: EffectIdSchema });
const Thoughts = v.object({ effect: EffectIdSchema });
// a speaker's own effect and a thought effect are two; a few more leaves room, and no more
const Preview = v.object({
  url: v.pipe(v.string(), v.maxLength(512)),
  chains: v.pipe(v.array(ChainSchema), v.maxLength(8)),
});
// Pedalboard code worth pasting is a screenful; this is many of them
const Parse = v.object({ code: v.pipe(v.string(), v.maxLength(64 * 1024)) });

/** `<base>/effects` */
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

  /**
   * A clip of this library's played through `chains`, as a WAV; nothing is kept. The url is one a
   * clip was given (`AudioFiles.write`), checked the way the audio route checks it, so nothing
   * outside the library's clips can be read through here.
   */
  app.post("/preview", validate("json", Preview), async (c) => {
    const { url, chains } = c.req.valid("json");
    const run = await runner();
    const [bookId, file, ...rest] = url.startsWith(`${files.base}/audio/`)
      ? url.slice(`${files.base}/audio/`.length).split("/")
      : [];
    const format = file && !rest.length ? formatOfFile(file) : null;
    const path = format && (await files.ready(bookId, file));
    if (!format || !path || !(await Bun.file(path).exists())) throw notFound("No such audio file");
    let wav: Uint8Array;
    try {
      wav = await run.render(await Bun.file(path).bytes(), format, chains, c.req.raw.signal);
    } catch (e) {
      if (c.req.raw.signal.aborted) throw e;
      throw badRequest(`The effect could not be played: ${(e as Error).message}`);
    }
    return c.body(wav as Uint8Array<ArrayBuffer>, 200, { "content-type": "audio/wav" });
  });

  /** Pasted Pedalboard code as a chain, read and never run (`effects.py`). */
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

  app.post("/", validate("json", EffectBodySchema), (c) => {
    const { name, chain } = c.req.valid("json");
    return c.json({ effect: ops.createEffect(db, name, chain) satisfies Effect }, 201);
  });

  /** Its name and its chain, replaced; the id stays. */
  app.put("/:id", validate("param", EffectParam), validate("json", EffectBodySchema), (c) => {
    const { name, chain } = c.req.valid("json");
    return c.json({
      effect: ops.updateEffect(db, c.req.valid("param").id, name, chain) satisfies Effect,
    });
  });

  /** Gone, and every choice of it with it (`deleteEffect`). */
  app.delete("/:id", validate("param", EffectParam), (c) => {
    const { id } = c.req.valid("param");
    ops.deleteEffect(db, id);
    return c.json({ removed: id });
  });

  return app;
}

/** `<base>/settings`: the library's settings that have a route of their own. */
export function settingRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/thoughts", (c) => c.json({ effect: ops.libraryThoughts(db) satisfies ThoughtChoice }));

  /** An effect's id, or "none". */
  app.put("/thoughts", validate("json", Thoughts), (c) =>
    c.json({ effect: ops.setLibraryThoughts(db, c.req.valid("json").effect) }),
  );

  return app;
}
