// The endpoints over HTTP: the Endpoints page's configuration, read and saved whole.
// The rules are in `server/endpoints/ops.ts`.
import { Hono, type HonoRequest } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type {
  ClonedVoice,
  EndpointBatches,
  EndpointProbe,
  KeptVoiceSamples,
  VoiceListPage,
} from "@/types";
import { tooMuchSaid } from "@/lib/voiceSamples";
import { ENDPOINT_KINDS } from "@/lib/endpointShapes";
import type { Db } from "~/db/client";
import { clipsByEndpoint } from "~/db/script";
import { CLONE_BODY_BYTES } from "~/env";
import * as ops from "~/endpoints/ops";
import { fail } from "~/lib/errors";
import {
  CredentialSchema,
  EndpointSchema,
  ProfileSchema,
  PromptTemplateSchema,
  ScriptSettingsSchema,
  TranscriberSchema,
} from "~/lib/schemas";
import { serveFile } from "~/lib/serve";
import type { SpeechGate } from "~/providers/gate";
import { validate } from "~/lib/validate";
import type { Providers } from "~/providers/target";
import type { VoiceFiles } from "~/voices/files";
import * as clone from "~/voices/clone";
import * as samples from "~/voices/ops";

const Config = v.object({
  endpoints: v.array(EndpointSchema),
  profiles: v.array(ProfileSchema),
  /** left out keeps the ones stored */
  transcribers: v.optional(v.array(TranscriberSchema)),
  credentials: v.array(CredentialSchema),
  /** left out keeps it; null goes back to the built-in one */
  prompt: v.optional(v.nullable(PromptTemplateSchema)),
  /** left out keeps what is stored */
  script: v.optional(ScriptSettingsSchema),
});

const Probe = v.object({
  kind: v.picklist(ENDPOINT_KINDS),
  id: v.pipe(v.string(), v.nonEmpty()),
});

const Saved = v.object({ id: v.pipe(v.string(), v.nonEmpty()) });

const Sample = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  voice: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});

const VoiceParam = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  voice: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});
const SampleParam = v.object({ ...VoiceParam.entries, file: v.string() });

type Form = FormData;

const formOf = (req: HonoRequest): Promise<Form> =>
  req.formData().catch(() => fail(400, "The request was not a form"));

/** A text field of a form, trimmed; empty when it is missing or was sent as a file. */
const textOf = (form: Form, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** `transcripts` holds one entry per file under `samples`, in the same order. */
const samplesOf = (form: Form): { files: File[]; transcripts: string[] } => ({
  files: form.getAll("samples").filter((f): f is File => f instanceof File),
  transcripts: form.getAll("transcripts").map((t) => (typeof t === "string" ? t : "")),
});

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
   * Per speech endpoint sent to by this process: lines out and waiting, rate limits, cooldown end,
   * plus the clips it rendered that the library plays (for every book).
   */
  app.get("/live", (c) => {
    const live = gate.live();
    for (const [id, counts] of clipsByEndpoint(db))
      live[id] = {
        ...(live[id] ?? { active: 0, waiting: 0, rateLimits: 0, backoffUntil: 0 }),
        ...counts,
      };
    return c.json({ endpoints: live });
  });

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

  /** The Test button: one small real request with the saved key. */
  app.post("/test", validate("json", Probe), async (c) => {
    const { kind, id } = c.req.valid("json");
    const answer = await ops.testEndpoint(db, providers, kind, id, c.req.raw.signal);
    c.var.logger.info({ kind, id, ok: answer.ok, ms: answer.ms }, "endpoint tested");
    return c.json(answer satisfies EndpointProbe);
  });

  /**
   * The clone form's Transcribe button: a multipart `file` and optional `id` (default: the first
   * transcription endpoint switched on). Answers `{ text }`.
   */
  app.post("/transcribe", samplesLimit, async (c) => {
    const form = await formOf(c.req);
    const file = form.get("file");
    if (!(file instanceof File)) fail(400, "Send the recording as `file`");
    const id = textOf(form, "id") || undefined;
    const heard = await ops.transcribeSample(db, providers, file, id, c.req.raw.signal);
    c.var.logger.info({ id, chars: heard.text.length }, "sample transcribed");
    return c.json(heard);
  });

  /** What a speech endpoint's server says about batches. */
  app.post("/batch", validate("json", Saved), async (c) => {
    const { id } = c.req.valid("json");
    const answer = await ops.batchLimits(db, providers, id, c.req.raw.signal);
    return c.json(answer satisfies EndpointBatches);
  });

  /**
   * A voice's sample audio, made once, billed and kept (`sampleVoice`). `x-sample-source` says
   * where it came from, `x-sample-kept` that nothing was asked of the provider this time, and
   * `x-audio-duration` how long it plays when known.
   */
  app.post("/sample", validate("json", Sample), async (c) => {
    const { id, voice } = c.req.valid("json");
    const sample = await ops.sampleVoice(db, providers, voiceFiles, id, voice, c.req.raw.signal);
    c.var.logger.info({ id, voice, source: sample.source, kept: sample.kept }, "voice sampled");
    // copied onto a plain ArrayBuffer, which a response body is typed to take
    return c.body(new Uint8Array(sample.bytes), 200, {
      "content-type": sample.mime,
      "cache-control": "no-store",
      "x-sample-source": sample.source,
      "x-sample-kept": sample.kept ? "1" : "0",
      ...(sample.duration != null ? { "x-audio-duration": String(sample.duration) } : {}),
    });
  });

  /**
   * Multipart: `id`, `title`, 1–20 `samples` and a `transcripts` entry per file ("" for none).
   * Samples are kept only after the provider answers; failing to keep them is not a failed clone
   * (`samplesKept: false`). Read by hand, not `validate("form")`, which hands back a lone file for
   * one sample and words every refusal the same.
   */
  app.post("/voices/clone", samplesLimit, async (c) => {
    const form = await formOf(c.req);
    const id = textOf(form, "id");
    const title = textOf(form, "title");
    if (!id) fail(400, "Say which endpoint to make the voice on");
    if (!title || title.length > 100) fail(400, "Give the voice a name of up to 100 characters");
    const {
      voice,
      samples: count,
      keepError,
    } = await clone.cloneVoice(
      db,
      providers,
      voiceFiles,
      { endpointId: id, title, ...samplesOf(form) },
      c.req.raw.signal,
    );
    if (keepError)
      c.var.logger.warn(
        { err: keepError, id, voice: voice.id },
        "cloned, but the samples were not kept",
      );
    c.var.logger.info(
      { id, voice: voice.id, title, samples: count, samplesKept: voice.samplesKept },
      "voice cloned",
    );
    return c.json(voice satisfies ClonedVoice, 201);
  });

  /** Every voice of the endpoint that has its samples kept. */
  app.get("/:id/samples", validate("param", v.object({ id: VoiceParam.entries.id })), (c) =>
    c.json(samples.keptFor(db, c.req.valid("param").id) satisfies KeptVoiceSamples[]),
  );

  app.get("/:id/voices/:voice/samples", validate("param", VoiceParam), (c) => {
    const { id, voice } = c.req.valid("param");
    return c.json(samples.keptOf(db, id, voice) satisfies KeptVoiceSamples);
  });

  /** Named by its bytes, so it may be cached for good. */
  app.get("/:id/voices/:voice/samples/:file", validate("param", SampleParam), async (c) => {
    const { id, voice, file } = c.req.valid("param");
    const { path, type } = samples.sampleFile(db, voiceFiles, id, voice, file);
    return serveFile(c, path, type, {
      missing: "There is no such sample",
      detail: `file: ${file}`,
    });
  });

  /** Replace a voice's kept samples; the same form as a clone, and nothing goes to the provider. */
  app.post("/:id/voices/:voice/samples", validate("param", VoiceParam), samplesLimit, async (c) => {
    const { id, voice } = c.req.valid("param");
    const form = await formOf(c.req);
    const kept = await clone.keepForVoice(db, voiceFiles, {
      endpointId: id,
      voiceId: voice,
      ...samplesOf(form),
    });
    c.var.logger.info({ id, voice, samples: kept.samples.length }, "voice samples kept");
    return c.json(kept satisfies KeptVoiceSamples);
  });

  /** The voice stays, and the forget can be taken back for a while. */
  app.delete("/:id/voices/:voice/samples", validate("param", VoiceParam), (c) => {
    const { id, voice } = c.req.valid("param");
    samples.forgetSampleFiles(db, id, voice);
    c.var.logger.info({ id, voice }, "voice samples forgotten");
    return c.json({ voiceId: voice });
  });

  /** Works until a save removes the forgotten files. */
  app.post("/:id/voices/:voice/samples/restore", validate("param", VoiceParam), (c) => {
    const { id, voice } = c.req.valid("param");
    const kept = samples.restoreSampleFiles(db, id, voice);
    c.var.logger.info({ id, voice }, "voice samples restored");
    return c.json(kept satisfies KeptVoiceSamples);
  });

  /** An endpoint's own voices, or a page of a public search. Adding one is the PUT above. */
  app.post("/voices", validate("json", VoiceList), async (c) => {
    const { id, ...query } = c.req.valid("json");
    const answer = await ops.listVoices(db, providers, id, query, c.req.raw.signal);
    c.var.logger.info(
      { id, source: query.source, voices: answer.voices.length, page: answer.page },
      "voices listed",
    );
    return c.json(answer satisfies VoiceListPage);
  });

  return app;
}
