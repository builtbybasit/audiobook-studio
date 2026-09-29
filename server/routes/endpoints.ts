// The endpoints over HTTP: the configuration the Endpoints page edits, read whole and saved whole.
// Both routes are one call on `server/endpoints/ops.ts`, where the rules are.
import { Hono, type HonoRequest } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { ClonedVoice } from "@/types";
import { CLONE_CONSENT } from "@/lib/endpointShapes";
import { MAX_SAMPLES_BYTES, tooMuchSaid } from "@/lib/voiceSamples";
import type { Db } from "~/db/client";
import * as ops from "~/endpoints/ops";
import { fail, notFound } from "~/lib/errors";
import {
  CredentialSchema,
  EndpointSchema,
  ProfileSchema,
  PromptTemplateSchema,
} from "~/lib/schemas";
import { fileResponse } from "~/lib/serve";
import type { SpeechGate } from "~/providers/gate";
import { validate } from "~/lib/validate";
import type { Providers } from "~/providers/target";
import type { VoiceFiles } from "~/voices/files";
import * as clone from "~/voices/clone";
import * as samples from "~/voices/ops";

const Config = v.object({
  endpoints: v.array(EndpointSchema),
  profiles: v.array(ProfileSchema),
  credentials: v.array(CredentialSchema),
  /** the library's default scripting prompt: left out keeps it, null goes back to the built-in one */
  prompt: v.optional(v.nullable(PromptTemplateSchema)),
});

const Probe = v.object({
  kind: v.picklist(["tts", "scripting"]),
  id: v.pipe(v.string(), v.nonEmpty()),
});

const Sample = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  voice: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});

/**
 * The largest body the clone and keep routes read: the samples, and a little over for the multipart
 * envelope around them. The server's own ceiling (`maxRequestBodySize`) is set above it, so these
 * routes are the ones that answer.
 */
export const CLONE_BODY_BYTES = MAX_SAMPLES_BYTES + 256 * 1024;

/** The most a consent sentence sent with the form may be; the form sends `CLONE_CONSENT`. */
const MAX_CONSENT_CHARS = 500;

const VoiceParam = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  voice: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});
const SampleParam = v.object({ ...VoiceParam.entries, file: v.string() });

type Form = FormData;

/** A form's body, or the refusal that says it was not one. */
const formOf = (req: HonoRequest): Promise<Form> =>
  req.formData().catch(() => fail(400, "The request was not a form"));

/**
 * The person's say-so, and the sentence they said it to: `consent=yes`, or nothing leaves. The
 * sentence is what the form showed (`consentText`), or the server's own when a form sends none.
 */
function consentOf(form: Form): string {
  if (form.get("consent") !== "yes")
    fail(
      400,
      "Confirm you have the right to clone this voice",
      "Cloning someone's voice needs their permission; the form has to say it was given.",
    );
  const said = String(form.get("consentText") ?? "").trim();
  return said ? said.slice(0, MAX_CONSENT_CHARS) : CLONE_CONSENT;
}

/** The files under `samples`; what each one is, and whether the provider takes it, is `readSamples`'. */
const filesOf = (form: Form): File[] =>
  form.getAll("samples").filter((f): f is File => f instanceof File);

const samplesLimit = bodyLimit({
  maxSize: CLONE_BODY_BYTES,
  onError: () => fail(413, tooMuchSaid()),
});

const VoiceList = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  source: v.picklist(["library", "public"]),
  query: v.optional(v.pipe(v.string(), v.maxLength(200))),
  language: v.optional(v.pipe(v.string(), v.maxLength(20))),
  page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
});

export function endpointRoutes(
  db: Db,
  providers: Providers,
  voiceFiles: VoiceFiles,
  gate: SpeechGate,
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/", (c) => c.json(ops.endpointSettings(db)));

  /**
   * What this process has seen of each speech endpoint it has sent to: lines out and waiting, rate
   * limits, the end of a cooldown. An endpoint nothing has been sent to is not in it.
   */
  app.get("/live", (c) => c.json({ endpoints: gate.live() }));

  /** The whole configuration, in place of what is stored. */
  app.put("/", validate("json", Config), (c) => {
    const saved = ops.saveEndpoints(db, c.req.valid("json"), voiceFiles);
    // a concurrency raised or an endpoint resumed applies to the lines already waiting on it
    gate.changed();
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
   * One voice of a saved speech endpoint, heard: the audio itself, in the format it was made in.
   * Kept from before, or the provider's own recording of the voice, or the endpoint saying the
   * sample sentence — a real request, priced into the ledger, made once and kept (`sampleVoice`).
   * `x-sample-source` says which of the last two it is, `x-sample-kept` whether nothing was asked
   * of the provider this time, and `x-audio-duration` how long it plays when that is known.
   */
  app.post("/sample", validate("json", Sample), async (c) => {
    const { id, voice } = c.req.valid("json");
    const sample = await ops.sampleVoice(db, providers, voiceFiles, id, voice, c.req.raw.signal);
    c.var.logger.info({ id, voice, source: sample.source, kept: sample.kept }, "voice sampled");
    // copied onto a plain ArrayBuffer, which is what a response body is typed to take
    return c.body(new Uint8Array(sample.bytes), 200, {
      "content-type": sample.mime,
      "cache-control": "no-store",
      "x-sample-source": sample.source,
      "x-sample-kept": sample.kept ? "1" : "0",
      ...(sample.duration != null ? { "x-audio-duration": String(sample.duration) } : {}),
    });
  });

  /**
   * A voice made from recordings, on a saved endpoint whose provider can keep one: a multipart form
   * of the endpoint's `id`, the voice's `title`, 1 to 20 samples under `samples`, `consent` saying
   * the person has the right to clone the voice in them, and the `consentText` they agreed to.
   * Answers with the new voice, which the page then adds to the endpoint.
   *
   * The recordings are kept once the provider has answered — never before, so a failed clone keeps
   * nothing — beside the consent they were given under, so the voice can travel with a book's
   * script. The voice already exists on the account by then, so a failure to keep them is not a
   * failure to clone: the answer says `samplesKept: false`, and the page says so.
   *
   * The form is read by hand, where the book uploads go through `validate("form", …)`: the
   * validator hands back a lone file for one recording and an array for several, and answers every
   * refusal as "the form was not valid" — where each refusal here has its own words for the page.
   */
  app.post("/voices/clone", samplesLimit, async (c) => {
    // Fish takes its time over an upload this size, and Bun closes a request whose answer has not
    // started within ten seconds. This one is left open, for as long as the cloner's own clock
    // allows; under a test there is no Bun server, and nothing to lift.
    (c.env as { timeout?(request: Request, seconds: number): void } | undefined)?.timeout?.(
      c.req.raw,
      0,
    );
    const form = await formOf(c.req);
    const id = String(form.get("id") ?? "").trim();
    const title = String(form.get("title") ?? "").trim();
    if (!id) fail(400, "Say which endpoint to make the voice on");
    if (!title || title.length > 100) fail(400, "Give the voice a name of up to 100 characters");
    const consentText = consentOf(form);
    const {
      voice,
      samples: count,
      keepError,
    } = await clone.cloneVoice(
      db,
      providers,
      voiceFiles,
      { endpointId: id, title, consentText, files: filesOf(form) },
      c.req.raw.signal,
    );
    if (keepError)
      c.var.logger.warn(
        { err: keepError, id, voice: voice.id },
        "cloned, but the samples were not kept",
      );
    // The form cannot get here without `consent=yes`; the kept row is the lasting record of it,
    // and this line says the same for whoever reads the log.
    c.var.logger.info(
      { id, voice: voice.id, title, samples: count, consent: true, samplesKept: voice.samplesKept },
      "voice cloned",
    );
    return c.json(voice satisfies ClonedVoice, 201);
  });

  /** Every voice of a saved endpoint that has the recordings it was made from kept. */
  app.get("/:id/samples", validate("param", v.object({ id: VoiceParam.entries.id })), (c) =>
    c.json(samples.keptFor(db, c.req.valid("param").id)),
  );

  /** One voice's kept recordings, and when and to what consent was given. */
  app.get("/:id/voices/:voice/samples", validate("param", VoiceParam), (c) => {
    const { id, voice } = c.req.valid("param");
    return c.json(samples.keptOf(db, id, voice));
  });

  /** One kept recording, as it was picked. Named by its bytes, so it may be cached for good. */
  app.get("/:id/voices/:voice/samples/:file", validate("param", SampleParam), async (c) => {
    const { id, voice, file } = c.req.valid("param");
    const { path, type } = samples.sampleFile(db, voiceFiles, id, voice, file);
    const found = Bun.file(path);
    if (!(await found.exists())) throw notFound("There is no such recording", `file: ${file}`);
    return fileResponse(c.req.raw, found, {
      "content-type": type,
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  /**
   * Keep these recordings for a voice already on the saved endpoint, in place of any it had: for a
   * voice cloned before recordings were kept. The same form, limits and consent as a clone, and
   * nothing is sent to the provider.
   */
  app.post("/:id/voices/:voice/samples", validate("param", VoiceParam), samplesLimit, async (c) => {
    const { id, voice } = c.req.valid("param");
    const form = await formOf(c.req);
    const consentText = consentOf(form);
    const kept = await clone.keepForVoice(db, voiceFiles, {
      endpointId: id,
      voiceId: voice,
      consentText,
      files: filesOf(form),
    });
    c.var.logger.info(
      { id, voice, samples: kept.samples.length, consent: true },
      "voice samples kept",
    );
    return c.json(kept);
  });

  /** Forget one voice's recordings; the voice stays, and the forget can be taken back for a while. */
  app.delete("/:id/voices/:voice/samples", validate("param", VoiceParam), (c) => {
    const { id, voice } = c.req.valid("param");
    samples.forgetSampleFiles(db, id, voice);
    c.var.logger.info({ id, voice }, "voice samples forgotten");
    return c.json({ voiceId: voice });
  });

  /** Take back a forget whose recordings no save has removed yet; answers with them. */
  app.post("/:id/voices/:voice/samples/restore", validate("param", VoiceParam), (c) => {
    const { id, voice } = c.req.valid("param");
    const kept = samples.restoreSampleFiles(db, id, voice);
    c.var.logger.info({ id, voice }, "voice samples restored");
    return c.json(kept);
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
