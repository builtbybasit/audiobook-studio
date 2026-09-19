// The server, started.
//
// Migrations run before the first request is served, so a checkout that has just pulled a schema
// change is usable without a separate step.
import { createApp } from "~/app";
import { openDb } from "~/db/client";
import { migrate } from "~/db/migrate";
import { env } from "~/env";
import { log } from "~/log";

const boot = log.child({ name: "boot" });

const db = openDb();
const started = performance.now();
migrate(db);
boot.debug(
  { database: env.DATABASE_URL, ms: Math.round(performance.now() - started) },
  "migrations applied",
);

const server = Bun.serve({
  port: env.PORT,
  // A long web novel is a big upload, and Bun's default body limit is well under it.
  maxRequestBodySize: env.MAX_UPLOAD_MB * 1024 * 1024,
  fetch: createApp(db).fetch,
});

boot.info(
  {
    url: `http://localhost:${server.port}`,
    database: env.DATABASE_URL,
    uploadMb: env.MAX_UPLOAD_MB,
  },
  "audiobook-studio api is listening",
);
