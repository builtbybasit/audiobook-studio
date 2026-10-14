// The queue's worker: one job at a time, oldest first, so a book's chapters run in order (roster
// and recap carry forward) and two jobs never write at once. Handles claiming, cancelling, and
// recovering jobs a dead process was holding; handlers are looked up by `job.kind`.
import type { Job, JobEvent, JobKind, JobStatus } from "@/types";
import type { Db } from "~/db/client";
import * as queue from "~/db/jobs";
import { AppError } from "~/lib/errors";
import type { Logger } from "~/log";

export interface JobContext {
  readonly job: Job;
  readonly db: Db;
  /** aborted when the job is cancelled or the server is stopping; check it between steps */
  readonly signal: AbortSignal;
  readonly log: Logger;
  progress(percent: number): void;
  note(message: string, level?: JobEvent["level"], detail?: JobEvent["detail"]): void;
}

/**
 * Returns when done; throws to fail. Any throw after the signal aborted is a cancellation.
 * `onSettled` runs after the row is finished, on every path, for cleanup.
 */
export interface JobHandler {
  run(ctx: JobContext): Promise<void>;
  onSettled?(ctx: JobContext, status: queue.SettledStatus): void;
}

export type JobHandlers = Partial<Record<JobKind, JobHandler>>;

export interface RunnerOptions {
  log: Logger;
  /** ms between safety-net polls; `kick` is the real wake-up */
  pollMs?: number;
  /** starts a job gets before recovery stops requeueing it */
  maxAttempts?: number;
}

/** Why a running job was aborted. `stop` puts the job back; `cancel` finishes it. */
type AbortReason = "cancel" | "stop";

export interface Runner {
  /** Queue and wake the worker; returns the existing job if the same work is already queued. */
  enqueue(input: queue.EnqueueInput): queue.Enqueued;
  cancel(id: number): "queued" | "running" | "finished" | "missing";
  kick(): void;
  start(): void;
  /** Resolves once the job is not running and its row is finished. */
  finished(id: number): Promise<void>;
  /** Hand the running job back to the queue and stop taking work. */
  stop(): Promise<void>;
  idle(): Promise<void>;
  readonly running: Job | null;
}

const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";

export function createRunner(
  db: Db,
  handlers: JobHandlers,
  { log, pollMs = 2000, maxAttempts = 2 }: RunnerOptions,
): Runner {
  const rlog = log.child({ name: "jobs" });
  let current: {
    job: Job;
    controller: AbortController;
    reason: AbortReason | null;
    ended: Promise<void>;
  } | null = null;
  let draining: Promise<void> | null = null;
  /** a kick that arrived after the worker last looked at the queue; see `kick` */
  let missed = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function contextFor(job: Job, signal: AbortSignal): JobContext {
    return {
      job,
      db,
      signal,
      log: rlog.child({ job: job.id, kind: job.kind, book: job.bookId, chapter: job.chapterId }),
      progress: (pct) => queue.setProgress(db, job.id, pct),
      note: (message, level = "info", detail) =>
        queue.appendEvent(db, job.id, message, level, detail),
    };
  }

  /** Call `onSettled` on every finish path, including ones where `run` never ran. */
  function settled(
    job: Job,
    status: queue.SettledStatus,
    ctx = contextFor(job, AbortSignal.abort()),
  ): void {
    try {
      handlers[job.kind]?.onSettled?.(ctx, status);
    } catch (e) {
      ctx.log.error({ err: e }, "a job's onSettled threw");
    }
  }

  async function runOne(job: Job): Promise<void> {
    const controller = new AbortController();
    let end!: () => void;
    current = { job, controller, reason: null, ended: new Promise<void>((r) => (end = r)) };
    const ctx = contextFor(job, controller.signal);
    const jlog = ctx.log;
    const handler = handlers[job.kind];
    let status: Extract<JobStatus, "done" | "failed" | "cancelled">;
    let detail: JobEvent["detail"] | undefined;
    try {
      if (!handler) throw new Error(`This server has no handler for ${job.kind} jobs`);
      await handler.run(ctx);
      // Returned means done, even if a cancel arrived late: `onSettled` for a cancel would undo
      // what the handler just committed.
      status = "done";
    } catch (e) {
      if (controller.signal.aborted || isAbortError(e)) status = "cancelled";
      else {
        status = "failed";
        const message = e instanceof Error ? e.message : String(e);
        detail = {
          error: message,
          ...(e instanceof AppError && e.detail ? { detail: e.detail } : {}),
        };
        jlog.warn({ err: e }, "job failed");
      }
    }

    // bookkeeping can throw (e.g. the book was removed mid-run); never take the worker down
    try {
      // A stop leaves the row `running` like a crash, so `recoverInterrupted` is the one recovery
      // path; but the attempt is given back, so only a job that keeps crashing runs out.
      if (status === "cancelled" && current?.reason === "stop") {
        queue.appendEvent(db, job.id, "The server stopped while this ran", "warning");
        queue.handBack(db, job.id);
        jlog.info("job handed back to the queue");
        return;
      }
      queue.finishJob(db, job.id, status, Date.now(), detail);
      settled(job, status, ctx);
      jlog.info({ status, ms: Date.now() - (job.startedAt ?? Date.now()) }, `job ${status}`);
    } catch (e) {
      jlog.error({ err: e }, "could not record how the job ended");
    } finally {
      current = null;
      end();
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      if (stopped) return;
      // this look at the queue sees everything enqueued before it
      missed = false;
      let job: Job | undefined;
      try {
        job = queue.claimNext(db);
      } catch (e) {
        // the database is not answering; the interval will try again
        rlog.error({ err: e }, "could not claim the next job");
        return;
      }
      if (!job) return;
      await runOne(job);
    }
  }

  /**
   * `draining` is set before `drain` runs: `drain` claims a job before its first `await`, and a kick
   * in that window would start a second worker. A kick during a drain sets `missed`, since the
   * drain may already be leaving an empty queue; one more drain follows.
   */
  function kick(): void {
    if (draining) {
      missed = true;
      return;
    }
    let done!: () => void;
    draining = new Promise<void>((r) => (done = r));
    void drain().finally(() => {
      draining = null;
      done();
      if (missed && !stopped) kick();
    });
  }

  return {
    get running() {
      return current?.job ?? null;
    },
    enqueue(input) {
      const result = queue.enqueueJob(db, input);
      if (result.created)
        rlog.info({ job: result.job.id, kind: input.kind, label: input.label }, "job queued");
      if (!stopped) kick();
      return result;
    },
    cancel(id) {
      const was = queue.requestCancel(db, id);
      if (was === "running" && current?.job.id === id) {
        current.reason = "cancel";
        current.controller.abort(new DOMException("The job was cancelled", "AbortError"));
      }
      // a queued job was finished on the spot; its handler still gets to put things back
      if (was === "queued") {
        const job = queue.getJob(db, id);
        if (job) settled(job, "cancelled");
      }
      return was;
    },
    finished(id) {
      return current?.job.id === id ? current.ended : Promise.resolve();
    },
    kick,
    start() {
      if (timer) throw new Error("The runner is already started");
      stopped = false;
      const recovered = queue.recoverInterrupted(db, { maxAttempts });
      for (const { id, status } of recovered.settled) {
        const job = queue.getJob(db, id);
        if (job) settled(job, status);
      }
      if (recovered.requeued.length || recovered.settled.length)
        rlog.warn(
          { requeued: recovered.requeued, gaveUp: recovered.settled.map((s) => s.id) },
          "recovered jobs the last process was holding",
        );
      kick();
      timer = setInterval(kick, pollMs);
      // don't keep the process alive
      (timer as { unref?: () => void }).unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (current) {
        current.reason = "stop";
        current.controller.abort(new DOMException("The server is stopping", "AbortError"));
      }
      await draining;
    },
    async idle() {
      while (draining) await draining;
    },
  };
}
