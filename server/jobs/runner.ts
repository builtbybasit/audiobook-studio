// The queue's worker: one job at a time, in the order they were asked for.
//
// One at a time because this is a personal, single-machine app and the queue's own rule — one
// book's chapters run sequentially so roster and recap carry forward — is easier to keep as a
// property of the runner than to re-derive per handler. What runs inside a job may fan out as it
// likes; the runner only promises that two jobs never write at once.
//
// Three things the runner is responsible for, and nothing else:
//
//   * **claiming** — `drain` takes the oldest queued job and runs its handler; `kick` wakes it after
//     an enqueue, and a slow interval is a safety net for anything that went in without one.
//   * **cancelling** — a running job has an `AbortController`; cancelling aborts it, the handler
//     sees `signal`, and whatever it returns or throws afterwards is recorded as `cancelled`. A
//     queued job is finished as cancelled without ever starting.
//   * **recovering** — `start` first puts back any job the last process died holding, so a restart
//     loses no work, and `stop` hands the running job back to the queue rather than abandoning it.
//
// Handlers are looked up by `job.kind`. A kind with no handler fails at once and says so.
import type { Job, JobEvent, JobKind, JobStatus } from "@/types";
import type { Db } from "~/db/client";
import * as queue from "~/db/jobs";
import { AppError } from "~/lib/errors";
import type { Logger } from "~/log";

/** What a handler is given: the job, a way to say how far it is, and a way to say what happened. */
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
 * The work of one job.
 *
 * Returns when done; throws to fail. A throw after the signal was aborted is a cancellation, not a
 * failure, whatever was thrown. `onSettled` is called after the row has been finished, with the
 * status it ended in, for a handler that has to put something back either way.
 */
export interface JobHandler {
  run(ctx: JobContext): Promise<void>;
  onSettled?(ctx: JobContext, status: queue.SettledStatus): void;
}

export type JobHandlers = Partial<Record<JobKind, JobHandler>>;

export interface RunnerOptions {
  log: Logger;
  /** how often to look for work nobody kicked for, in ms; the safety net, not the mechanism */
  pollMs?: number;
  /** how many starts a job gets before a restart stops putting it back in the queue */
  maxAttempts?: number;
}

/** Why a running job was aborted. `stop` puts the job back; `cancel` finishes it. */
type AbortReason = "cancel" | "stop";

export interface Runner {
  /** Put work in the queue and wake the worker. The same work already queued is handed back instead. */
  enqueue(input: queue.EnqueueInput): queue.Enqueued;
  /** Stop a job: a queued one never starts, a running one is aborted. Says which it was. */
  cancel(id: number): "queued" | "running" | "finished" | "missing";
  /** Wake the worker; safe to call at any time. */
  kick(): void;
  /** Recover interrupted work, then run and keep running until `stop`. */
  start(): void;
  /** Hand a running job back to the queue and stop taking work. Resolves once the worker is idle. */
  stop(): Promise<void>;
  /** Resolves when the worker has nothing left to do. For tests, mostly. */
  idle(): Promise<void>;
  /** The job being worked on right now, if any. */
  readonly running: Job | null;
}

const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";

export function createRunner(
  db: Db,
  handlers: JobHandlers,
  { log, pollMs = 2000, maxAttempts = 2 }: RunnerOptions,
): Runner {
  const rlog = log.child({ name: "jobs" });
  let current: { job: Job; controller: AbortController; reason: AbortReason | null } | null = null;
  let draining: Promise<void> | null = null;
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

  /**
   * Give a handler the last word on a job that has been finished, whichever path finished it.
   *
   * A cancel of a queued job and a recovery that gives up on one both settle rows without a
   * handler ever running, and the handler is the only thing that knows what else has to be put
   * back — a chapter marked `queued`, say.
   */
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

  /** Run one claimed job to its end and record what it came to. */
  async function runOne(job: Job): Promise<void> {
    const controller = new AbortController();
    current = { job, controller, reason: null };
    const ctx = contextFor(job, controller.signal);
    const jlog = ctx.log;
    const handler = handlers[job.kind];
    let status: Extract<JobStatus, "done" | "failed" | "cancelled">;
    let detail: JobEvent["detail"] | undefined;
    try {
      if (!handler) throw new Error(`This server has no handler for ${job.kind} jobs`);
      await handler.run(ctx);
      // A handler that returned finished. A cancel or a stop is honoured by the handler throwing,
      // at the last point it can still take the work back; one that arrives after that — while an
      // export's final write commits, say — is too late, and calling the job cancelled then would
      // have its `onSettled` delete what it had just committed, or leave it `running` for the
      // next start to rebuild over.
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

    // Bookkeeping can fail too — the job's book was removed while it ran, say, and its row went
    // with it — and a throw here must not take the worker down with it: `current` is cleared
    // whatever happens, and the worker moves on to the next job.
    try {
      // A stop is not a cancellation. The row is left `running`, exactly as a crash would leave it,
      // and `recoverInterrupted` at the next start is the one thing that puts it back — so there is
      // one recovery path rather than two. What a stop does not do is count as a crash: the start
      // it interrupted is given back, so only a job that keeps taking the process down runs out.
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
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      if (stopped) return;
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
   * Wake the worker, once.
   *
   * `draining` is set before `drain` runs, not from its return value: `drain` does real work before
   * its first `await` — it claims a job and starts the handler — and a `kick` arriving inside that
   * window (an enqueue from a handler, the interval) would otherwise see nothing draining and start
   * a second worker beside the first.
   */
  function kick(): void {
    if (draining) return;
    let done!: () => void;
    draining = new Promise<void>((r) => (done = r));
    void drain().finally(() => {
      draining = null;
      done();
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
      // a timer must not be what keeps a process alive after everything else has stopped
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
