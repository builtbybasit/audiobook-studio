// The endpoints over HTTP: the configuration the Endpoints page edits, read whole and saved whole.
// Both routes are one call on `server/endpoints/ops.ts`, where the rules are.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import * as ops from "~/endpoints/ops";
import { CredentialSchema, EndpointSchema, ProfileSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";
import type { Providers } from "~/providers/target";

const Config = v.object({
  endpoints: v.array(EndpointSchema),
  profiles: v.array(ProfileSchema),
  credentials: v.array(CredentialSchema),
});

const Probe = v.object({
  kind: v.picklist(["tts", "scripting"]),
  id: v.pipe(v.string(), v.nonEmpty()),
});

const VoiceList = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  source: v.picklist(["library", "public"]),
  query: v.optional(v.pipe(v.string(), v.maxLength(200))),
  language: v.optional(v.pipe(v.string(), v.maxLength(20))),
  page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
});

export function endpointRoutes(db: Db, providers: Providers): Hono<PinoEnv> {
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

  /** One small real request to a saved endpoint, with its saved key: the Test button. */
  app.post("/test", validate("json", Probe), async (c) => {
    const { kind, id } = c.req.valid("json");
    const answer = await ops.testEndpoint(db, providers, kind, id, c.req.raw.signal);
    c.var.logger.info({ kind, id, ok: answer.ok, ms: answer.ms }, "endpoint tested");
    return c.json(answer);
  });

  /**
   * The voices a saved speech endpoint offers: its own library, or a page of a public search.
   * Only an answer — adding one to the endpoint is the whole-configuration PUT above.
   */
  app.post("/voices", validate("json", VoiceList), async (c) => {
    const { id, ...query } = c.req.valid("json");
    const answer = await ops.listVoices(db, providers, id, query, c.req.raw.signal);
    c.var.logger.info(
      { id, source: query.source, voices: answer.voices.length, page: answer.page },
      "voices listed",
    );
    return c.json(answer);
  });

  return app;
}
