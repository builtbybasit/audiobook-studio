// The server, started.
//
// Two libraries in one process (`server/libraries.ts`): the real one under `/api`, and the demo
// under `/demo/api` with a database and folders of its own. Each library's migrations run as it is
// opened, before the first request is served. The queues start after them and before the
// listener, so a job the last process was holding is back in its queue before anything can ask
// about it.
import { join } from "node:path";

import { ffmpegSpeechRate } from "~/audio/ffmpeg";
import { ffmpegThoughtEffect } from "~/audio/thoughtEffect";
import { CLONE_BODY_BYTES, env, importBodyBytes, scriptBodyBytes } from "~/env";
import { DEMO_BASE, openLibrary, REAL_BASE, serveLibraries } from "~/libraries";
import { log } from "~/log";
import { ffmpegAvailable, ffmpegEncoders } from "~/providers/ffmpegEncoder";

const boot = log.child({ name: "boot" });

// ffmpeg is the one thing here outside this process — the audiobook encoder, the thought effect and
// the 16 kHz a transcriber is sent — so it is checked now rather than at the first build: a server
// without it says so at boot, naming the binary, instead of queueing work that was always going to
// fail.
const ffmpeg = await ffmpegAvailable(env.FFMPEG_BIN);
if (!ffmpeg)
  throw new Error(
    `${env.FFMPEG_BIN} is not runnable. Install ffmpeg (brew install ffmpeg, apt install ffmpeg) ` +
      `or point FFMPEG_BIN at it.`,
  );
boot.debug({ ffmpeg }, "ffmpeg found");
const encoders = ffmpegEncoders(env.FFMPEG_BIN);
const thoughtEffect = ffmpegThoughtEffect(env.FFMPEG_BIN);
const speechRate = ffmpegSpeechRate(env.FFMPEG_BIN);

const real = openLibrary({
  name: "real",
  databaseUrl: env.DATABASE_URL,
  base: REAL_BASE,
  audioDir: env.AUDIO_DIR,
  exportDir: env.EXPORT_DIR,
  voiceDir: env.VOICE_DIR,
  encoders,
  thoughtEffect,
  speechRate,
});
const demo = openLibrary({
  name: "demo",
  databaseUrl: env.DEMO_DATABASE_URL,
  base: DEMO_BASE,
  audioDir: join(env.DEMO_DIR, "audio"),
  exportDir: join(env.DEMO_DIR, "exports"),
  voiceDir: join(env.DEMO_DIR, "voices"),
  encoders,
  thoughtEffect,
  speechRate,
  demo: true,
});
const libraries = [real, demo];
for (const library of libraries) await library.start();

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  // A long web novel is a big upload, and so are a voice's recordings and a script that carries them; Bun's default body limit is
  // well under either. Set a megabyte above the larger of the two routes' own limits, so that the
  // route is the one that answers — in the API's error shape, before the body is read — and this
  // only catches what gets past it.
  maxRequestBodySize:
    Math.max(importBodyBytes(), scriptBodyBytes(), CLONE_BODY_BYTES) + 1024 * 1024,
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

// A running job is handed back to its queue rather than abandoned mid-write, and the listener
// closes after both queues have, so a `pnpm dev:server` restart loses nothing.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    boot.info({ signal }, "stopping");
    void Promise.all(libraries.map((l) => l.runner.stop())).then(() => {
      server.stop(true);
      process.exit(0);
    });
  });
