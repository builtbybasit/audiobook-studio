// The API, as a value.
//
// Built around a database handle rather than importing one, so a test can hand it a private
// `:memory:` database and drive the real routes end to end without a server listening anywhere.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { pinoLogger, type Env as PinoEnv } from "hono-pino";

import type { Db } from "~/db/client";
import { createRunner, type Runner } from "~/jobs/runner";
import { AppError, type ApiError } from "~/lib/errors";
import type { Logger } from "~/log";
import { log as defaultLog } from "~/log";
import { bookRoutes } from "~/routes/books";
import { castRoutes } from "~/routes/cast";
import { exportRoutes } from "~/routes/exports";
import { jobRoutes } from "~/routes/jobs";
import { scriptRoutes } from "~/routes/script";

export interface AppOptions {
  /** the logger requests are recorded against; a test hands over a silent one */
  log?: Logger;
  /**
   * The queue the routes enqueue into and cancel through. The default has no handlers, so a job
   * enqueued into it fails at once saying so — right for a test that is not about jobs, and
   * impossible to mistake for one that ran.
   */
  runner?: Runner;
}

export function createApp(
  db: Db,
  { log = defaultLog, runner = createRunner(db, {}, { log }) }: AppOptions = {},
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

  app.get("/api/health", (c) => c.json({ ok: true }));
  // Everything a book owns is addressed under it. The library's own routes come first; the cast,
  // the scripts and the audiobooks each have a file of their own so that a route reads as one call
  // on the operations of the part of the app that owns the table.
  app.route("/api/books", bookRoutes(db, runner));
  app.route("/api/books", castRoutes(db));
  app.route("/api/books", scriptRoutes(db));
  app.route("/api/books", exportRoutes(db));
  app.route("/api/jobs", jobRoutes(db, runner));

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
    if (err instanceof HTTPException) return err.getResponse();
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
