// The library's voice effects over HTTP, and its thought effect. Both belong to the installation
// rather than to a book; every route is one call on `server/effects/ops.ts`.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Effect, ThoughtChoice } from "@/types";
import type { Db } from "~/db/client";
import * as ops from "~/effects/ops";
import { EffectBodySchema, EffectIdSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";

const EffectParam = v.object({ id: EffectIdSchema });
const Thoughts = v.object({ effect: EffectIdSchema });

/** `<base>/effects` */
export function effectRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

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
