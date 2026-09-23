// The API, as a value.
//
// Built around a database handle rather than importing one, so a test can hand it a private
// `:memory:` database and drive the real routes end to end without a server listening anywhere.
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { pinoLogger, type Env as PinoEnv } from "hono-pino";

import { audioFiles, type AudioFiles } from "~/audio/files";
import type { Db } from "~/db/client";
import { env } from "~/env";
import { audiobookFiles } from "~/exports/files";
import { createRunner, type Runner } from "~/jobs/runner";
import { AppError, codeFor, type ApiError } from "~/lib/errors";
import type { Logger } from "~/log";
import { log as defaultLog } from "~/log";
import type { ExportPorts } from "~/providers/encoder";
import { wavEncoders } from "~/providers/wavEncoder";
import { audioRoutes } from "~/routes/audio";
import { bookRoutes } from "~/routes/books";
import { castRoutes } from "~/routes/cast";
import { exportRoutes } from "~/routes/exports";
import { jobRoutes } from "~/routes/jobs";
import { scriptRoutes } from "~/routes/script";

/** What Hono's refusals say, for the ones that come without a message of their own. */
const REFUSED: Partial<Record<number, string>> = {
  403: "That request came from another site, and was refused",
};

export interface AppOptions {
  /** the logger requests are recorded against; a test hands over a silent one */
  log?: Logger;
  /**
   * The queue the routes enqueue into and cancel through. The default has no handlers, so a job
   * enqueued into it fails at once saying so — right for a test that is not about jobs, and
   * impossible to mistake for one that ran.
   */
  runner?: Runner;
  /** where rendered clips are read from and, when a book goes, removed; the configured directory by default */
  files?: AudioFiles;
  /**
   * What a build writes an audiobook with, and where it puts it. The default is the configured
   * pair, so a download served by this app is the file the queue's handler wrote.
   */
  exports?: ExportPorts;
}

export function createApp(
  db: Db,
  {
    log = defaultLog,
    runner = createRunner(db, {}, { log }),
    files = audioFiles(env.AUDIO_DIR),
    exports = { encoders: wavEncoders(), files: audiobookFiles(env.EXPORT_DIR) },
  }: AppOptions = {},
): Hono<PinoEnv> {
  // Typed with the logger the middleware puts on the context, so a route reaching for
  // `c.var.logger` is checked rather than trusted.
  const app = new Hono<PinoEnv>();

  // One line per request, with the logger for that request on the context. A route reaching for
  // `c.var.logger` gets the method and path already attached, so what it adds is only ever the part
  // it knows about.
  app.use(
    pinoLogger({
      pino: log,
      http: {
        // Method and path, and nothing else. The default writes every request header on every
        // line, which buries the one field anybody was reading and puts an `authorization` in the
        // log for the redaction list to have to catch.
        onReqBindings: (c) => ({ req: { method: c.req.method, url: c.req.path } }),
        onResBindings: (c) => ({ res: { status: c.res.status } }),
        /**
         * A 404 is an answer, not a fault.
         *
         * hono-pino's default calls anything with an error on the context an `error`, which makes
         * "no such book" and "the database is gone" the same severity — and a log where routine
         * answers are red is one nobody can skim for the real thing.
         */
        onResLevel: (c) => (c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info"),
      },
    }),
  );

  // The API has no accounts, and a request that deletes a book is a request that deletes a book.
  // Listening on loopback keeps other machines out (see `HOST`); this keeps other *sites* out. A
  // page on any origin can make the browser send a form post or a bodyless one here without
  // asking first — the kind that needs no preflight — and Hono's check refuses it unless the
  // browser says it came from this origin. The rest need a preflight this API never answers.
  //
  // Only a browser is asked. Its requests carry `Origin` or `Sec-Fetch-Site`, and one with neither
  // is a script, a test or `curl`, which is on this machine already and forges nothing.
  const sameSite = csrf();
  app.use("/api/*", (c, next) =>
    c.req.header("origin") || c.req.header("sec-fetch-site") ? sameSite(c, next) : next(),
  );
  // The standard set: no sniffing a clip as something else, no framing, no borrowing a response
  // from another origin.
  app.use("/api/*", secureHeaders());

  app.get("/api/health", (c) => c.json({ ok: true }));
  // Everything a book owns is addressed under it. The library's own routes come first; the cast,
  // the scripts and the audiobooks each have a file of their own so that a route reads as one call
  // on the operations of the part of the app that owns the table.
  app.route("/api/books", bookRoutes(db, runner, files, exports.files));
  app.route("/api/books", castRoutes(db));
  app.route("/api/books", scriptRoutes(db, runner));
  app.route("/api/books", exportRoutes(db, runner, exports));
  app.route("/api/jobs", jobRoutes(db, runner));
  // A clip's url is served from disk, and the files it names belong to the same book routes above
  // remove — see `server/audio/files.ts` for why the path is a book and a token.
  app.route("/api/audio", audioRoutes(files));

  app.notFound((c) =>
    c.json(
      {
        error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` },
      } satisfies ApiError,
      404,
    ),
  );

  // A refusal a rule raised is an answer, and it is answered in the one error shape. Anything
  // else is a bug, not a message for the user: the client gets one sentence it can show, and the
  // stack goes to the log, where it is of use to somebody.
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.body(), err.status);
    // Hono's own refusals — a body that is not the JSON it claims, a post from another site — are
    // answers too, and get the same shape rather than the plain text Hono writes by default.
    if (err instanceof HTTPException)
      return c.json(
        {
          error: {
            code: codeFor(err.status),
            message: err.message || REFUSED[err.status] || "That request was refused",
          },
        } satisfies ApiError,
        err.status,
      );
    (c.var.logger ?? log).error({ err }, "unhandled request error");
    return c.json(
      {
        error: { code: "internal", message: "Something went wrong on the server" },
      } satisfies ApiError,
      500,
    );
  });

  return app;
}
