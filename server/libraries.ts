// The libraries one server holds: the real one, and the demo.
//
// A library is the whole of one: its own database, its own queue and the speech gate it narrates
// through, its own clips, audiobooks and voice recordings, and the API over them under a base of
// its own. Both are built here from the same options, so they can only differ in what they are
// given — and neither is given anything of the other's. The demo cannot reach the real database,
// because nothing in it holds a handle to that database.
//
// Requests are told apart by path alone (`serveLibraries`): the demo's base is `/demo/api`, and
// every url it writes — a clip's, a cover's — is under it, so what the demo made is only ever
// served by the demo.
import type { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";

import type { SpeechRate } from "~/audio/ffmpeg";
import type { ThoughtEffect } from "~/audio/thoughtEffect";
import { createApp } from "~/app";
import { demoClips } from "~/audio/demoClips";
import { audioFiles, type AudioFiles } from "~/audio/files";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import { startLive, type DemoLive } from "~/demo/live";
import { newPace, pacedEncoders, pacedProviders } from "~/demo/pace";
import { demoReset } from "~/demo/reset";
import { isFresh, seedDemo } from "~/demo/seed";
import { audiobookFiles } from "~/exports/files";
import { checkHandler } from "~/jobs/check";
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
import { voiceFiles as voiceFilesIn } from "~/voices/files";

/** The base the real library is under, and the demo's. */
export const REAL_BASE = "/api";
export const DEMO_BASE = "/demo/api";

export interface LibraryOptions {
  /** named on every line the library logs: `real` or `demo` */
  name: string;
  /** the SQLite file; `:memory:` for a test */
  databaseUrl: string;
  /** the path its API is under, and its clips' and covers' urls with it */
  base: string;
  audioDir: string;
  exportDir: string;
  voiceDir: string;
  /** what its builds write audiobooks with — one choice for the whole process, checked at boot */
  encoders: EncoderChoice;
  /**
   * What a `thought` line is given as its clip lands — ffmpeg's, when the server found one at boot.
   * Absent = thought lines are kept as the voice made them.
   */
  thoughtEffect?: ThoughtEffect;
  /**
   * What a recording is made into before a transcription endpoint hears it — 16 kHz mono, ffmpeg's,
   * when the server found one at boot. Absent = sent as it came.
   */
  speechRate?: SpeechRate;
  /** the logger its own is a child of */
  log?: Logger;
  /**
   * What scripting and narration send their work to. The endpoints' own by default, as a running
   * server has them; a test hands over ones whose `fetch` fails it.
   */
  providers?: Providers;
  /**
   * The demo: seeded when its database is fresh, given the routes that empty it and seed it again
   * — as it began, or in a Demo tools situation — and set how fast its simulated work runs, and
   * making a seeded clip's file the first time it is read. The real library is none of these — a
   * fresh one starts empty, its runs take the time they take, and a clip file it has lost stays
   * lost.
   */
  demo?: boolean;
  /**
   * For the demo: seed it without the runs its world starts with (`startupRuns`), on opening and on
   * a reset. A situation's own runs still go. For a test that reasons about the queue, which the
   * startup runs would keep busy for the best part of a minute.
   */
  still?: boolean;
}

export interface Library {
  readonly name: string;
  readonly base: string;
  /** the SQLite file it was opened on, for the boot log */
  readonly database: string;
  readonly db: Db;
  /** its queue, not yet started: `start` the library once the server is about to listen */
  readonly runner: Runner;
  /**
   * Start its queue, and then — for a demo seeded as it was opened — set going what the seed
   * describes that is not a row: its endpoints' recent trouble and the runs it starts with, as a
   * reset does.
   */
  start(): Promise<void>;
  readonly app: Hono<PinoEnv>;
  readonly files: AudioFiles;
  readonly exports: ExportPorts;
  readonly providers: Providers;
}

/** The providers with a transcriber: the one given, else the endpoints' own, sent at `speechRate`. */
const withTranscription = (
  p: Providers,
  speechRate: SpeechRate | undefined,
): Providers & Required<Pick<Providers, "transcription">> => ({
  ...p,
  transcription: p.transcription ?? endpointTranscriber({ speechRate }),
});

/**
 * Open one library: its database migrated, its queue built with the four handlers, its API.
 *
 * Migrations run here, before anything can ask the database a question, so a checkout that has
 * just pulled a schema change is usable without a separate step.
 */
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

  // Where a request goes, with what model and what key, is the Endpoints page's — read from the
  // database at the moment of each request. An endpoint or profile set to `simulated://` is
  // answered here without one, and nothing it does is billed.
  const given = withTranscription(
    options.providers ?? {
      scripting: endpointScriptingProvider(),
      speech: endpointSpeechProvider(),
    },
    options.speechRate,
  );
  // The demo's simulated work runs at the speed its drawer sets, and its builds take the time the
  // browser's did, so one running is seen running (`demo/pace.ts`). The real library has no pace.
  const pace = newPace();
  const providers = options.demo ? pacedProviders(given, pace) : given;
  const files = audioFiles(options.audioDir, base, options.demo ? demoClips(db) : undefined);
  const exports = {
    encoders: options.demo ? pacedEncoders(options.encoders, pace) : options.encoders,
    files: audiobookFiles(options.exportDir),
  };
  const voiceFiles = voiceFilesIn(options.voiceDir);
  // One gate for every line this library sends to a speech endpoint, shared by the narration
  // handler and the routes that save the endpoints and show what they are doing.
  const gate = createSpeechGate();
  const runner = createRunner(
    db,
    {
      scripting: scriptingHandler(providers.scripting),
      narration: narrationHandler(providers.speech, files, gate, options.thoughtEffect),
      export: exportHandler(exports, files),
      check: checkHandler(given.transcription, files),
    },
    { log },
  );

  const live = (l: DemoLive) => startLive({ db, runner, gate, files, exports }, l);
  // what a seed made as the demo was opened leaves for once its queue is running
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
    demo,
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

/**
 * One `fetch` for both: a path under the demo's base goes to the demo, and every other path to the
 * real library — whose own 404 answers anything it does not know.
 */
export function serveLibraries(real: Library, demo: Library): Hono<PinoEnv>["fetch"] {
  const isDemo = (path: string) => path === demo.base || path.startsWith(`${demo.base}/`);
  return (request, ...rest) =>
    (isDemo(new URL(request.url).pathname) ? demo : real).app.fetch(request, ...rest);
}
