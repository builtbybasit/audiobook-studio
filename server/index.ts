// Starts the server: the real library and the demo in one process (`server/libraries.ts`).
// Queues start before the listener, so a job the last process held is requeued before any request.
import { join } from "node:path";

import { pedalboardRunner } from "~/audio/effects";
import { ffmpegSpeechRate } from "~/audio/ffmpeg";
import { ffmpegThoughtEffect } from "~/audio/thoughtEffect";
import { ffmpegTrim } from "~/audio/trim";
import { CLONE_BODY_BYTES, env, importBodyBytes, scriptBodyBytes } from "~/env";
import { DEMO_BASE, openLibrary, REAL_BASE, serveLibraries } from "~/libraries";
import { log } from "~/log";
import { ffmpegAvailable, ffmpegEncoders } from "~/providers/ffmpegEncoder";
import { localServers } from "~/servers/localServers";
import { parselmouthMeter } from "~/voices/measure";

const boot = log.child({ name: "boot" });

// ffmpeg is required (encoding, thought effect, trimming, transcription input), so fail at boot without it.
const ffmpeg = await ffmpegAvailable(env.FFMPEG_BIN);
if (!ffmpeg)
  throw new Error(
    `${env.FFMPEG_BIN} is not runnable. Install ffmpeg (brew install ffmpeg, apt install ffmpeg) ` +
      `or point FFMPEG_BIN at it.`,
  );
boot.debug({ ffmpeg }, "ffmpeg found");
const encoders = ffmpegEncoders(env.FFMPEG_BIN);
// uv is optional: without it thought lines fall back to the ffmpeg effect and speaker effects are
// skipped. Probed now in the background so the first run doesn't wait on Pedalboard's download.
const effects = pedalboardRunner({ ffmpeg: env.FFMPEG_BIN });
void effects
  .available()
  .then((ok) =>
    boot.info({ pedalboard: ok }, ok ? "voice effects run" : "no uv: voice effects fall back"),
  );
// also under uv, also probed now, so the first voice profile doesn't wait on Praat's download
const meter = parselmouthMeter({ ffmpeg: env.FFMPEG_BIN });
void meter
  .unavailable()
  .then((why) =>
    boot.info({ praat: !why }, why ? "voices are not measured" : "voices are measured"),
  );
const thoughtEffect = ffmpegThoughtEffect(env.FFMPEG_BIN);
const speechRate = ffmpegSpeechRate(env.FFMPEG_BIN);
const trim = ffmpegTrim(env.FFMPEG_BIN);

const real = openLibrary({
  name: "real",
  databaseUrl: env.DATABASE_URL,
  base: REAL_BASE,
  audioDir: env.AUDIO_DIR,
  exportDir: env.EXPORT_DIR,
  voiceDir: env.VOICE_DIR,
  encoders,
  effects,
  meter,
  thoughtEffect,
  speechRate,
  trim,
});
const demo = openLibrary({
  name: "demo",
  databaseUrl: env.DEMO_DATABASE_URL,
  base: DEMO_BASE,
  audioDir: join(env.DEMO_DIR, "audio"),
  exportDir: join(env.DEMO_DIR, "exports"),
  voiceDir: join(env.DEMO_DIR, "voices"),
  encoders,
  effects,
  meter,
  thoughtEffect,
  speechRate,
  trim,
  demo: true,
});
const libraries = [real, demo];
for (const library of libraries) await library.start();

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  // Above every route's own limit, so the route answers in the API's error shape; Bun's default
  // is too small for big EPUBs and voice samples.
  maxRequestBodySize:
    Math.max(importBodyBytes(), scriptBodyBytes(), CLONE_BODY_BYTES) + 1024 * 1024,
  // Off: Bun's 10 s default closes a request a slow provider is still answering (a prompt trial
  // may wait 300 s, past Bun's 255 s cap), after it was billed. The routes keep their own limits.
  idleTimeout: 0,
  fetch: serveLibraries(real, demo),
});

boot.info(
  {
    url: server.url.href,
    uploadMb: env.MAX_UPLOAD_MB,
    encoder: encoders.name,
    libraries: Object.fromEntries(
      libraries.map((l) => [
        l.name,
        {
          base: l.base,
          database: l.database,
          audio: l.files.dir,
          audiobooks: l.exports.files.dir,
        },
      ]),
    ),
  },
  "audiobook-studio api is listening",
);

// Running jobs go back to their queue before the listener closes, so a restart loses nothing.
// The local servers stop after, once no request is out at them.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    boot.info({ signal }, "stopping");
    void Promise.all(libraries.map((l) => l.runner.stop()))
      .then(() => localServers.stopAll())
      .finally(() => {
        void server.stop(true);
        process.exit(0);
      });
  });
