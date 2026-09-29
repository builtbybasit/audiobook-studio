// The demo library's routes of its own: putting it back the way it started, putting it into one of
// the Demo tools situations, and how fast its simulated work runs.
//
// Mounted only on the demo (`createApp`'s `demo`), so the real library has no request that empties
// it or changes its pace — not a refused one, none at all.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import { SPEEDS } from "@/lib/demoSpeed";
import { DEMO_GROUPS, demoScenario, demoScenarios } from "@/mock/scenarios/catalogue";
import type { AppliedSituation, DemoScenario, DemoSituation, DemoSituations } from "@/types";
import type { Pace } from "~/demo/pace";
import type { Seeding } from "~/demo/seed";
import { notFound } from "~/lib/errors";
import { validate } from "~/lib/validate";

/**
 * Empty the demo and seed it again, with the situation applied when one is given; resolves with
 * what the seed put back and what the situation did.
 */
export type Reset = (scenario?: DemoScenario) => Promise<Seeding>;

/** What the demo library hands its routes: its reset, and the pace its simulated work runs at. */
export interface DemoControls {
  reset: Reset;
  pace: Pace;
}

/** A speed the drawer offers, and no other. */
const Speed = v.object({ speed: v.picklist(SPEEDS.map((s) => s.value)) });

/** What the drawer shows of a row, and what an applied one answers with. */
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

  /** Every situation the Demo tools offer, and the headings they are listed under. */
  app.get("/situations", (c) =>
    c.json({
      groups: DEMO_GROUPS,
      situations: demoScenarios().map(row),
    } satisfies DemoSituations),
  );

  /**
   * The demo, seeded again with one situation applied. The answer says what it did and where to
   * look at it: the situation's own path, unless what it did decided a more exact one.
   */
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

  /** Every simulated wait in the demo divided by this from the next one on (`demo/pace.ts`). */
  app.put("/speed", validate("json", Speed), (c) => {
    pace.speed = c.req.valid("json").speed;
    c.var.logger.info({ speed: pace.speed }, "the demo's speed was set");
    return c.json({ speed: pace.speed });
  });

  return app;
}
