// The endpoints over HTTP: the configuration the Endpoints page edits, read whole and saved whole.
// Both routes are one call on `server/endpoints/ops.ts`, where the rules are.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import * as ops from "~/endpoints/ops";
import { CredentialSchema, EndpointSchema, ProfileSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";

const Config = v.object({
  endpoints: v.array(EndpointSchema),
  profiles: v.array(ProfileSchema),
  credentials: v.array(CredentialSchema),
});

export function endpointRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/", (c) => c.json(ops.endpointSettings(db)));

  /** The whole configuration, in place of what is stored. */
  app.put("/", validate("json", Config), (c) => {
    const saved = ops.saveEndpoints(db, c.req.valid("json"));
    c.var.logger.info(
      { endpoints: saved.endpoints.length, profiles: saved.profiles.length },
      "endpoints saved",
    );
    return c.json(saved);
  });

  return app;
}
