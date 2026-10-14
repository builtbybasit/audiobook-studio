// The demo's own routes: reset, situations, and simulated speed. Mounted only on the demo, so the
// real library has no request that empties it.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import { SPEEDS } from "@/lib/demoSpeed";
import { DEMO_GROUPS, demoScenario, demoScenarios } from "~/demo/seed/scenarios/catalogue";
import type { AppliedSituation, DemoScenario, DemoSituation, DemoSituations } from "@/types";
import type { Pace } from "~/demo/pace";
import type { Seeding } from "~/demo/seed";
import { notFound } from "~/lib/errors";
import { validate } from "~/lib/validate";

/** Empty and reseed the demo, applying `scenario` when given. */
export type Reset = (scenario?: DemoScenario) => Promise<Seeding>;

export interface DemoControls {
  reset: Reset;
  pace: Pace;
}

const Speed = v.object({ speed: v.picklist(SPEEDS.map((s) => s.value)) });

/** A drawer row, and what an applied situation answers with. */
const row = ({ id, group, name, blurb, bookId, path, steps }: DemoScenario): DemoSituation => ({
  id,
  group,
  name,
  blurb,
  bookId,
  path,
  steps: steps ?? [],
});

export function demoRoutes({ reset, pace }: DemoControls): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.post("/reset", async (c) => {
    const { seeded } = await reset();
    c.var.logger.info(seeded, "the demo was reset");
    return c.json({ seeded });
  });

  app.get("/situations", (c) =>
    c.json({
      groups: DEMO_GROUPS,
      situations: demoScenarios().map(row),
    } satisfies DemoSituations),
  );

  /** Answers what it did and where to look: the situation's path unless it picked a better one. */
  app.post("/situations/:id", async (c) => {
    const scenario = demoScenario(c.req.param("id"));
    if (!scenario) throw notFound("There is no such demo situation");
    const { result } = await reset(scenario);
    c.var.logger.info({ situation: scenario.id }, "the demo was put into a situation");
    const { id, name, bookId, path, steps } = row(scenario);
    return c.json({
      scenario: { id, name, bookId, path, steps },
      note: result?.note ?? "",
      open: result?.open ?? path,
    } satisfies AppliedSituation);
  });

  app.get("/speed", (c) => c.json({ speed: pace.speed }));

  /** Every simulated wait from the next one on is divided by this (`demo/pace.ts`). */
  app.put("/speed", validate("json", Speed), (c) => {
    pace.speed = c.req.valid("json").speed;
    c.var.logger.info({ speed: pace.speed }, "the demo's speed was set");
    return c.json({ speed: pace.speed });
  });

  return app;
}
