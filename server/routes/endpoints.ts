// The endpoints over HTTP: the configuration the Endpoints page edits, read whole and saved whole.
// Both routes are one call on `server/endpoints/ops.ts`, where the rules are.
import { Hono, type HonoRequest } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { ClonedVoice } from "@/types";
import { CLONE_CONSENT, MAX_CLONE_CLIPS } from "@/lib/endpointShapes";
import type { Db } from "~/db/client";
import * as ops from "~/endpoints/ops";
import { fail, notFound } from "~/lib/errors";
import { CredentialSchema, EndpointSchema, ProfileSchema } from "~/lib/schemas";
import { fileResponse } from "~/lib/serve";
import { validate } from "~/lib/validate";
import { RECORDING_HEAD_BYTES, RECORDING_MIME, sniffRecording } from "~/providers/clone";
import type { Providers } from "~/providers/target";
import type { VoiceFiles } from "~/voices/files";
import * as samples from "~/voices/ops";

const Config = v.object({
  endpoints: v.array(EndpointSchema),
  profiles: v.array(ProfileSchema),
  credentials: v.array(CredentialSchema),
});

const Probe = v.object({
  kind: v.picklist(["tts", "scripting"]),
  id: v.pipe(v.string(), v.nonEmpty()),
});

const Sample = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  voice: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});

/** The most one recording may be, and all of them together, in bytes. */
export const MAX_CLIP_BYTES = 20 * 1024 * 1024;
const MAX_CLONE_BYTES = 100 * 1024 * 1024;
/**
 * The largest body the clone route reads: the recordings, and a little over for the multipart
 * envelope around them. The server's own ceiling (`maxRequestBodySize`) is set above it, so this
 * route is the one that answers.
 */
export const CLONE_BODY_BYTES = MAX_CLONE_BYTES + 256 * 1024;

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

/**
 * The recordings under `clips`, each typed by what its first bytes say it is: its name and the type
 * the browser gave it are only guesses, and reading the whole of it to find out would be a copy of
 * every recording. Refused, with the file's own name, before anything is sent or kept.
 */
async function clipsOf(form: Form): Promise<samples.KeptClip[]> {
  const files = form.getAll("clips").filter((f): f is File => f instanceof File);
  if (!files.length) fail(400, "Add at least one recording of the voice");
  if (files.length > MAX_CLONE_CLIPS) fail(400, `Use at most ${MAX_CLONE_CLIPS} recordings`);
  const clips: samples.KeptClip[] = [];
  for (const f of files) {
    // Bun's parser drops an empty file's name, so a refusal cannot always quote it
    const named = f.name || "One of the recordings";
    if (f.size > MAX_CLIP_BYTES)
      fail(413, `${named} is larger than ${MAX_CLIP_BYTES / 1024 / 1024} MB`);
    if (!f.size) fail(400, `${named} is empty`);
    const head = await f.slice(0, RECORDING_HEAD_BYTES).arrayBuffer();
    const format = sniffRecording(new Uint8Array(head));
    if (!format)
      fail(
        415,
        `${named} is not a recording Fish can make a voice from`,
        "Use WAV, MP3, M4A, Opus or FLAC audio.",
      );
    // the parsed file itself, typed by its bytes: a slice is a view, not a copy
    clips.push({
      name: f.name || `recording.${format}`,
      blob: f.slice(0, f.size, RECORDING_MIME[format]),
      format,
    });
  }
  return clips;
}

const recordingsLimit = bodyLimit({
  maxSize: CLONE_BODY_BYTES,
  onError: () => fail(413, `The recordings come to more than ${MAX_CLONE_BYTES / 1024 / 1024} MB`),
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
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/", (c) => c.json(ops.endpointSettings(db)));

  /** The whole configuration, in place of what is stored. */
  app.put("/", validate("json", Config), (c) => {
    const saved = ops.saveEndpoints(db, c.req.valid("json"), voiceFiles);
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
   * One voice of a saved speech endpoint saying the sample sentence: the audio itself, in the
   * format the endpoint answered with, and how long it plays. A real request, priced into the ledger.
   */
  app.post("/sample", validate("json", Sample), async (c) => {
    const { id, voice } = c.req.valid("json");
    const clip = await ops.sampleVoice(db, providers, id, voice, c.req.raw.signal);
    c.var.logger.info({ id, voice, ms: clip.ms, format: clip.format }, "voice sampled");
    // copied onto a plain ArrayBuffer, which is what a response body is typed to take
    return c.body(new Uint8Array(clip.bytes), 200, {
      "content-type": clip.mime,
      "cache-control": "no-store",
      "x-audio-duration": String(clip.duration),
    });
  });

  /**
   * A voice made from recordings, on a saved endpoint whose provider can keep one: a multipart form
   * of the endpoint's `id`, the voice's `title`, 1 to 20 recordings under `clips`, `consent` saying
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
  app.post("/voices/clone", recordingsLimit, async (c) => {
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
    const clips = await clipsOf(form);
    const voice = await ops.cloneVoice(db, providers, id, { title, clips }, c.req.raw.signal);
    let samplesKept = true;
    try {
      await samples.keepClips(db, voiceFiles, {
        endpointId: id,
        voiceId: voice.id,
        title,
        consentText,
        clips,
        attached: false,
      });
    } catch (err) {
      samplesKept = false;
      c.var.logger.warn({ err, id, voice: voice.id }, "cloned, but the recordings were not kept");
    }
    // The form cannot get here without `consent=yes`; the kept row is the lasting record of it,
    // and this line says the same for whoever reads the log.
    c.var.logger.info(
      { id, voice: voice.id, title, clips: clips.length, consent: true, samplesKept },
      "voice cloned",
    );
    return c.json({ ...voice, samplesKept } satisfies ClonedVoice, 201);
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
  app.post(
    "/:id/voices/:voice/samples",
    validate("param", VoiceParam),
    recordingsLimit,
    async (c) => {
      const { id, voice } = c.req.valid("param");
      const form = await formOf(c.req);
      const consentText = consentOf(form);
      const clips = await clipsOf(form);
      const kept = await samples.replaceClips(db, voiceFiles, {
        endpointId: id,
        voiceId: voice,
        consentText,
        clips,
      });
      c.var.logger.info(
        { id, voice, clips: kept.samples.length, consent: true },
        "voice samples kept",
      );
      return c.json(kept);
    },
  );

  /** Forget one voice's recordings; the voice stays. */
  app.delete("/:id/voices/:voice/samples", validate("param", VoiceParam), (c) => {
    const { id, voice } = c.req.valid("param");
    samples.forgetClips(db, voiceFiles, id, voice);
    c.var.logger.info({ id, voice }, "voice samples forgotten");
    return c.json({ voiceId: voice });
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
