// The endpoints over HTTP: the configuration the Endpoints page edits, read whole and saved whole.
// Both routes are one call on `server/endpoints/ops.ts`, where the rules are.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import { MAX_CLONE_CLIPS } from "@/lib/endpointShapes";
import type { Db } from "~/db/client";
import * as ops from "~/endpoints/ops";
import { fail } from "~/lib/errors";
import { CredentialSchema, EndpointSchema, ProfileSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";
import {
  RECORDING_HEAD_BYTES,
  RECORDING_MIME,
  sniffRecording,
  type CloneClip,
} from "~/providers/clone";
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
   * of the endpoint's `id`, the voice's `title`, 1 to 20 recordings under `clips`, and `consent`
   * saying the person has the right to clone the voice in them. Answers with the new voice, which
   * the page then adds to the endpoint. Only the recordings' way to the provider passes through here:
   * nothing is kept on this server.
   *
   * The form is read by hand, where the book uploads go through `validate("form", …)`: the
   * validator hands back a lone file for one recording and an array for several, and answers every
   * refusal as "the form was not valid" — where each refusal here has its own words for the page.
   */
  app.post(
    "/voices/clone",
    bodyLimit({
      maxSize: CLONE_BODY_BYTES,
      onError: () =>
        fail(413, `The recordings come to more than ${MAX_CLONE_BYTES / 1024 / 1024} MB`),
    }),
    async (c) => {
      // Fish takes its time over an upload this size, and Bun closes a request whose answer has not
      // started within ten seconds. This one is left open, for as long as the cloner's own clock
      // allows; under a test there is no Bun server, and nothing to lift.
      (c.env as { timeout?(request: Request, seconds: number): void } | undefined)?.timeout?.(
        c.req.raw,
        0,
      );
      const form = await c.req.formData().catch(() => fail(400, "The request was not a form"));
      const id = String(form.get("id") ?? "").trim();
      const title = String(form.get("title") ?? "").trim();
      if (!id) fail(400, "Say which endpoint to make the voice on");
      if (!title || title.length > 100) fail(400, "Give the voice a name of up to 100 characters");
      if (form.get("consent") !== "yes")
        fail(
          400,
          "Confirm you have the right to clone this voice",
          "Cloning someone's voice needs their permission; the form has to say it was given.",
        );
      const files = form.getAll("clips").filter((f): f is File => f instanceof File);
      if (!files.length) fail(400, "Add at least one recording of the voice");
      if (files.length > MAX_CLONE_CLIPS) fail(400, `Use at most ${MAX_CLONE_CLIPS} recordings`);
      const clips: CloneClip[] = [];
      for (const f of files) {
        // Bun's parser drops an empty file's name, so a refusal cannot always quote it
        const named = f.name || "One of the recordings";
        if (f.size > MAX_CLIP_BYTES)
          fail(413, `${named} is larger than ${MAX_CLIP_BYTES / 1024 / 1024} MB`);
        if (!f.size) fail(400, `${named} is empty`);
        // What it is, from its first bytes alone: its name and the type the browser gave it are
        // only guesses, and reading the whole of it to find out would be a copy of every recording.
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
        });
      }
      const voice = await ops.cloneVoice(db, providers, id, { title, clips }, c.req.raw.signal);
      // The form cannot get here without `consent=yes`, and this line is the record that it was
      // given: which endpoint, which voice, what it was called, and from how many recordings.
      c.var.logger.info(
        { id, voice: voice.id, title, clips: clips.length, consent: true },
        "voice cloned",
      );
      return c.json(voice, 201);
    },
  );

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
