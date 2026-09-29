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

import { createApp } from "~/app";
import { audioFiles, type AudioFiles } from "~/audio/files";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import { demoReset } from "~/demo/reset";
import { isFresh, seedDemo } from "~/demo/seed";
import { audiobookFiles } from "~/exports/files";
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
  /** the logger its own is a child of */
  log?: Logger;
  /**
   * What scripting and narration send their work to. The endpoints' own by default, as a running
   * server has them; a test hands over ones whose `fetch` fails it.
   */
  providers?: Providers;
  /**
   * The demo: seeded when its database is fresh, and given the route that empties it and seeds it
   * again. The real library is neither — a fresh one starts empty.
   */
  demo?: boolean;
}

export interface Library {
  readonly name: string;
  readonly base: string;
  /** the SQLite file it was opened on, for the boot log */
  readonly database: string;
  readonly db: Db;
  /** its queue, not yet started: `start` it once the server is about to listen */
  readonly runner: Runner;
  readonly app: Hono<PinoEnv>;
  readonly files: AudioFiles;
  readonly exports: ExportPorts;
  readonly providers: Providers;
}

/**
 * Open one library: its database migrated, its queue built with the three handlers, its API.
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
  const providers = options.providers ?? {
    scripting: endpointScriptingProvider(),
    speech: endpointSpeechProvider(),
  };
  const files = audioFiles(options.audioDir, base);
  const exports = { encoders: options.encoders, files: audiobookFiles(options.exportDir) };
  const voiceFiles = voiceFilesIn(options.voiceDir);
  // One gate for every line this library sends to a speech endpoint, shared by the narration
  // handler and the routes that save the endpoints and show what they are doing.
  const gate = createSpeechGate();
  const runner = createRunner(
    db,
    {
      scripting: scriptingHandler(providers.scripting),
      narration: narrationHandler(providers.speech, files, gate),
      export: exportHandler(exports, files),
    },
    { log },
  );

  if (options.demo && isFresh(db)) log.info(seedDemo(db, voiceFiles), "seeded the demo");
  const reset = options.demo
    ? demoReset({
        db,
        runner,
        gate,
        voiceFiles,
        dirs: [options.audioDir, options.exportDir, options.voiceDir],
      })
    : undefined;

  const app = createApp(db, {
    base,
    log,
    runner,
    files,
    exports,
    providers,
    voiceFiles,
    gate,
    reset,
  });
  return { name, base, database: options.databaseUrl, db, runner, app, files, exports, providers };
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
