// The server, started.
//
// Migrations run before the first request is served, so a checkout that has just pulled a schema
// change is usable without a separate step. The queue starts after them and before the listener,
// so a job the last process was holding is back in the queue before anything can ask about it.
import { createApp } from "~/app";
import { audioFiles } from "~/audio/files";
import { openDb } from "~/db/client";
import { migrate } from "~/db/migrate";
import { env } from "~/env";
import { narrationHandler } from "~/jobs/narration";
import { createRunner } from "~/jobs/runner";
import { scriptingHandler } from "~/jobs/scripting";
import { log } from "~/log";
import { fakeScriptingProvider } from "~/providers/fake";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";

const boot = log.child({ name: "boot" });

const db = openDb();
const started = performance.now();
migrate(db);
boot.debug(
  { database: env.DATABASE_URL, ms: Math.round(performance.now() - started) },
  "migrations applied",
);

// The providers are chosen once, here, from the server's own configuration. A key for a real one
// would be read from `env` by its implementation and would never leave this process.
const scripting = fakeScriptingProvider();
const speech = fakeSpeechProvider();
const files = audioFiles(env.AUDIO_DIR);
const runner = createRunner(
  db,
  { scripting: scriptingHandler(scripting), narration: narrationHandler(speech, files) },
  { log },
);
runner.start();

const server = Bun.serve({
  port: env.PORT,
  // A long web novel is a big upload, and Bun's default body limit is well under it.
  maxRequestBodySize: env.MAX_UPLOAD_MB * 1024 * 1024,
  fetch: createApp(db, { runner, files }).fetch,
});

boot.info(
  {
    url: `http://localhost:${server.port}`,
    database: env.DATABASE_URL,
    uploadMb: env.MAX_UPLOAD_MB,
    scripting: scripting.name,
    speech: speech.name,
    audio: files.dir,
  },
  "audiobook-studio api is listening",
);

// A running job is handed back to the queue rather than abandoned mid-write, and the listener
// closes after it, so a `pnpm dev:server` restart loses nothing.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    boot.info({ signal }, "stopping");
    void runner.stop().then(() => {
      server.stop(true);
      process.exit(0);
    });
  });
