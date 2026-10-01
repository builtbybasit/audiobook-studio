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
const JobIds = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
});

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

  /** Stop several jobs in one request, in the order given — a whole run is hundreds. Says which stopped. */
  app.post("/cancel", validate("json", JobIds), (c) => {
    const { ids } = c.req.valid("json");
    const cancelled = ids.filter((id) => {
      const was = runner.cancel(id);
      return was === "queued" || was === "running";
    });
    c.var.logger.info({ jobs: cancelled }, "cancel requested");
    return c.json({ cancelled });
  });

  /** Move queued jobs ahead of the rest, in their own order. Says which moved. */
  app.post("/run-next", validate("json", JobIds), (c) => {
    const moved = queue.runNext(db, c.req.valid("json").ids);
    c.var.logger.info({ jobs: moved }, "moved to run next");
    return c.json({ moved });
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
