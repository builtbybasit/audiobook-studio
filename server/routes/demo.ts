// The demo library's one route of its own: putting it back the way it started.
//
// Mounted only on the demo (`createApp`'s `reset`), so the real library has no request that empties
// it — not a refused one, none at all.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";

import type { Seeded } from "~/demo/seed";

/** Empty the demo and seed it again; resolves with what the seed put back. */
export type Reset = () => Promise<Seeded>;

export function demoRoutes(reset: Reset): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.post("/reset", async (c) => {
    const seeded = await reset();
    c.var.logger.info(seeded, "the demo was reset");
    return c.json({ seeded });
  });

  return app;
}
