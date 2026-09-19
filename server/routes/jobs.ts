// The queue over HTTP: what is running, what is waiting, what happened, and stop.
//
// Jobs are enqueued from the thing they are about — `POST /api/books/:id/chapters/script` — and
// this file is only ever about a job that already exists.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import * as queue from "~/db/jobs";
import type { Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";
import { IdParam } from "~/lib/http";
import { validate } from "~/lib/validate";

const JobId = v.object({ id: IdParam });
const ListQuery = v.object({ bookId: v.optional(v.string()) });

export function jobRoutes(db: Db, runner: Runner): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/", validate("query", ListQuery), (c) =>
    c.json({ jobs: queue.listJobs(db, c.req.valid("query")) }),
  );

  app.get("/:id", validate("param", JobId), (c) => {
    const job = queue.getJob(db, c.req.valid("param").id);
    if (!job) throw notFound("No such job");
    return c.json({ job });
  });

  /** Stop a job. A queued one never starts; a running one is told to stop and settles shortly. */
  app.post("/:id/cancel", validate("param", JobId), (c) => {
    const { id } = c.req.valid("param");
    const was = runner.cancel(id);
    if (was === "missing") throw notFound("No such job");
    c.var.logger.info({ job: id, was }, "cancel requested");
    return c.json({ job: queue.getJob(db, id), was });
  });

  /** Take a finished job out of the history. */
  app.delete("/:id", validate("param", JobId), (c) => {
    const { id } = c.req.valid("param");
    const job = queue.getJob(db, id);
    if (!job) throw notFound("No such job");
    if (!job.finishedAt) throw conflict("Cancel this job before removing it");
    queue.removeJob(db, id);
    return c.json({ removed: id });
  });

  /** Clear the history; live jobs stay. */
  app.post("/clear", (c) => c.json({ removed: queue.clearFinished(db) }));

  return app;
}
