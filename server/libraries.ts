// The real library and the demo: each its own database, queue, gate, files and API, built from the
// same options. Neither holds a handle to the other's, so the demo can't reach the real database.
// Requests are routed by path alone; every url the demo writes is under its base.
import type { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";

import type { SpeechRate } from "~/audio/ffmpeg";
import type { EffectRunner } from "~/audio/effects";
import type { ThoughtEffect } from "~/audio/thoughtEffect";
import type { TrimSilence } from "~/audio/trim";
import { createApp } from "~/app";
import { demoClips } from "~/audio/demoClips";
import { audioFiles, type AudioFiles } from "~/audio/files";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import { startLive, type DemoLive } from "~/demo/live";
import { simulatedEncoders } from "~/demo/encoder";
import { newPace, pacedEncoders, pacedProviders } from "~/demo/pace";
import { demoReset } from "~/demo/reset";
import { isFresh, seedDemo } from "~/demo/seed";
import { audiobookFiles } from "~/exports/files";
import { transcribeHandler } from "~/jobs/transcribe";
import { effectsHandler } from "~/jobs/effects";
import { exportHandler } from "~/jobs/export";
import { narrationHandler } from "~/jobs/narration";
import { createRunner, type Runner } from "~/jobs/runner";
import { scriptingHandler } from "~/jobs/scripting";
import { log as defaultLog, type Logger } from "~/log";
import type { EncoderChoice, ExportPorts } from "~/providers/encoder";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { createSpeechGate } from "~/providers/gate";
import type { Providers } from "~/providers/target";
import { endpointTranscriber } from "~/providers/transcription";
import { localServers, type LocalServers } from "~/servers/localServers";
import { voiceFiles as voiceFilesIn } from "~/voices/files";

export const REAL_BASE = "/api";
export const DEMO_BASE = "/demo/api";

export interface LibraryOptions {
  /** `real` or `demo`, on every log line */
  name: string;
  databaseUrl: string;
  base: string;
  audioDir: string;
  exportDir: string;
  voiceDir: string;
  encoders: EncoderChoice;
  /** Pedalboard under uv; absent = no voice effects, as on a machine without uv */
  effects?: EffectRunner;
  /** a `thought` line's effect where `effects` can't run; absent = left as the voice made it */
  thoughtEffect?: ThoughtEffect;
  /** cuts the voice's own silence off each clip; absent = kept as sent */
  trim?: TrimSilence;
  /** resamples to 16 kHz mono before transcription; absent = sent as it came */
  speechRate?: SpeechRate;
  log?: Logger;
  providers?: Providers;
  /** the real library's local servers; the process-wide ones by default, none for the demo */
  servers?: LocalServers;
  /** seeded when fresh, gets reset/situation routes and a pace, makes seeded clip files on read */
  demo?: boolean;
  /**
   * Demo only: seed without the startup runs (`startupRuns`), for a test that reasons about the
   * queue. A situation's own runs still go.
   */
  still?: boolean;
}

export interface Library {
  readonly name: string;
  readonly base: string;
  readonly database: string;
  readonly db: Db;
  /** not yet started; call `start` once the server is about to listen */
  readonly runner: Runner;
  /** Starts the queue, then a freshly seeded demo's live part (endpoint trouble, startup runs). */
  start(): Promise<void>;
  readonly app: Hono<PinoEnv>;
  readonly files: AudioFiles;
  readonly exports: ExportPorts;
  readonly providers: Providers;
}

const withTranscription = (
  p: Providers,
  speechRate: SpeechRate | undefined,
): Providers & Required<Pick<Providers, "transcription">> => ({
  ...p,
  transcription: p.transcription ?? endpointTranscriber({ speechRate }),
});

/** Opens one library; migrations run here, so a pulled schema change needs no separate step. */
export function openLibrary(options: LibraryOptions): Library {
  const { name, base } = options;
  const log = (options.log ?? defaultLog).child({ library: name });
  const db = openDb(options.databaseUrl);
  const started = performance.now();
  migrate(db);
  log.debug(
    { database: options.databaseUrl, ms: Math.round(performance.now() - started) },
    "migrations applied",
  );

  const given = withTranscription(
    options.providers ?? {
      scripting: endpointScriptingProvider(),
      speech: endpointSpeechProvider(),
    },
    options.speechRate,
  );
  const pace = newPace();
  const providers = options.demo ? pacedProviders(given, pace) : given;
  const files = audioFiles(options.audioDir, base, options.demo ? demoClips(db) : undefined);
  const exports = {
    encoders: options.demo
      ? pacedEncoders(simulatedEncoders(options.encoders), pace)
      : options.encoders,
    files: audiobookFiles(options.exportDir),
  };
  const voiceFiles = voiceFilesIn(options.voiceDir);
  // shared by the job handlers and the endpoint routes
  const gate = createSpeechGate();
  const runner = createRunner(
    db,
    {
      scripting: scriptingHandler(providers.scripting, gate),
      narration: narrationHandler(providers.speech, files, gate, {
        effects: options.effects,
        thoughtEffect: options.thoughtEffect,
        trim: options.trim,
      }),
      export: exportHandler(exports, files),
      transcribe: transcribeHandler(given.transcription, files, gate),
      effects: effectsHandler(options.effects, files),
    },
    { log },
  );

  const live = (l: DemoLive) => startLive({ db, runner, gate, files, exports }, l);
  // a fresh seed's live part, started once the queue runs
  let pending: DemoLive | null = null;
  if (options.demo && isFresh(db)) {
    const { seeded, live: seededLive } = seedDemo(db, voiceFiles, {
      base,
      now: Date.now(),
      still: options.still,
    });
    log.info(seeded, "seeded the demo");
    pending = seededLive;
  }
  const demo = options.demo
    ? {
        pace,
        reset: demoReset({
          db,
          runner,
          gate,
          voiceFiles,
          base,
          dirs: [options.audioDir, options.exportDir, options.voiceDir],
          live,
          still: options.still,
        }),
      }
    : undefined;
  async function start(): Promise<void> {
    runner.start();
    const seeded = pending;
    pending = null;
    if (seeded) await live(seeded);
  }

  const app = createApp(db, {
    base,
    log,
    runner,
    files,
    exports,
    providers,
    voiceFiles,
    gate,
    effects: options.effects,
    demo,
    servers: options.demo ? undefined : (options.servers ?? localServers),
  });
  return {
    name,
    base,
    database: options.databaseUrl,
    db,
    runner,
    start,
    app,
    files,
    exports,
    providers,
  };
}

/** One `fetch` for both: the demo's base goes to the demo, everything else to the real library. */
export function serveLibraries(real: Library, demo: Library): Hono<PinoEnv>["fetch"] {
  const isDemo = (path: string) => path === demo.base || path.startsWith(`${demo.base}/`);
  return (request, ...rest) =>
    (isDemo(new URL(request.url).pathname) ? demo : real).app.fetch(request, ...rest);
}
