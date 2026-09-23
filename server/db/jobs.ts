// Every read and write the queue makes.
//
// The `jobs` table was laid out to hold the frontend's `Job`, and this file keeps it that way: a
// row goes out through `toJob` and the Queue page reads it exactly as it reads a simulated one.
// What the server adds is discipline the browser never needed — a row cannot be queued twice for
// the same work, a claim moves a row to `running` in the same statement that reads it, and a job
// the process died holding is found again at the next boot.
//
// **`active_key` is the duplicate-request rule, and the database enforces it.** While a job is
// queued or running its key is `kind:book:chapter`; the moment it finishes the key is cleared. A
// unique index over the column means a second request for the same work cannot insert a second
// row whatever order the requests arrive in — SQLite treats NULLs as distinct, so finished jobs
// never collide with each other or with the one that is live.
import { and, asc, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";

import type { Job, JobEvent, JobKind, JobStatus } from "@/types";
import type { Db, Tx } from "~/db/client";
import { jobEvents, jobs } from "~/db/schema";
import { toJob } from "~/db/rows";

/** Events kept per job; the frontend keeps the same number, so the two agree on what a full log is. */
export const MAX_JOB_EVENTS = 1000;

/** A job that has not finished is holding its key; one that has is holding nothing. */
export const activeKey = (kind: JobKind, bookId: string, chapterId: number | null): string =>
  `${kind}:${bookId}:${chapterId ?? "book"}`;

export interface EnqueueInput {
  kind: JobKind;
  bookId: string;
  chapterId: number | null;
  label: string;
  /** the bulk run this job is part of, when several were asked for in one press */
  bulk?: Job["bulk"];
  /** the live detail the Queue page opens up, and what a handler needs to run it */
  run?: Pick<Job, "scriptRun" | "narrationRun" | "exportRun">;
  /**
   * Run in the same transaction, only when the job is created.
   *
   * For whatever has to change alongside the row — a chapter marked `queued` — so it cannot land
   * after the worker has already picked the job up and marked it something else.
   */
  onCreated?(tx: Tx, id: number): void;
}

export type Enqueued = { job: Job; created: true } | { job: Job; created: false };

function eventsOf(db: Db | Tx, ids: readonly number[]) {
  if (!ids.length) return [];
  return db.select().from(jobEvents).where(inArray(jobEvents.jobId, ids)).all();
}

function withEvents(db: Db | Tx, rows: (typeof jobs.$inferSelect)[]): Job[] {
  const events = eventsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) =>
    toJob(
      r,
      events.filter((e) => e.jobId === r.id),
    ),
  );
}

export function getJob(db: Db | Tx, id: number): Job | undefined {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  return row ? withEvents(db, [row])[0] : undefined;
}

/** Every job, oldest first — the order the Queue page sorts for itself. */
export function listJobs(db: Db | Tx, { bookId }: { bookId?: string } = {}): Job[] {
  const rows = db
    .select()
    .from(jobs)
    .where(bookId ? eq(jobs.bookId, bookId) : undefined)
    .orderBy(asc(jobs.id))
    .all();
  return withEvents(db, rows);
}

/**
 * Write a book's live jobs' duplicate keys again, from the chapter numbers they now have.
 *
 * A job's `chapter_id` follows a renumbering through its foreign key; `active_key` is a string
 * built from the number and follows nothing. Left alone, a job queued for chapter 7 that became
 * chapter 4 still says `narration:b:7` — so a second request for chapter 4 is not seen as a
 * duplicate and is paid for twice, and the new chapter 7 reads as busy when nothing is running on
 * it. Every key is parked on the job's own id first: `active_key` is unique, and writing chapter
 * 10's new key while chapter 7's job still holds it would collide mid-way.
 */
export function rekeyActive(tx: Tx, bookId: string): void {
  const live = tx
    .select({ id: jobs.id, kind: jobs.kind, chapterId: jobs.chapterId })
    .from(jobs)
    .where(and(eq(jobs.bookId, bookId), isNotNull(jobs.activeKey)))
    .all();
  for (const j of live)
    tx.update(jobs)
      .set({ activeKey: `renumbering:${j.id}` })
      .where(eq(jobs.id, j.id))
      .run();
  for (const j of live)
    tx.update(jobs)
      .set({ activeKey: activeKey(j.kind, bookId, j.chapterId) })
      .where(eq(jobs.id, j.id))
      .run();
}

/** The live job for this work, if there is one. */
export function activeJob(
  db: Db | Tx,
  kind: JobKind,
  bookId: string,
  chapterId: number | null,
): Job | undefined {
  const row = db
    .select()
    .from(jobs)
    .where(eq(jobs.activeKey, activeKey(kind, bookId, chapterId)))
    .get();
  return row ? withEvents(db, [row])[0] : undefined;
}

/** The next run id: one more than any run the queue has seen. */
export function nextRunId(db: Db | Tx): number {
  return (
    (db
      .select({ n: max(jobs.bulkId) })
      .from(jobs)
      .get()?.n ?? 0) + 1
  );
}

/**
 * Put a job in the queue, or hand back the one already doing this work.
 *
 * Idempotent on purpose: a double click, a retried request or two tabs asking for the same chapter
 * get the same job, and the unique index is what makes that true even if the two requests were to
 * interleave. The caller learns which it got through `created`.
 */
export function enqueueJob(db: Db, input: EnqueueInput, at = Date.now()): Enqueued {
  return db.transaction((tx) => {
    const existing = activeJob(tx, input.kind, input.bookId, input.chapterId);
    if (existing) return { job: existing, created: false };
    const { id } = tx
      .insert(jobs)
      .values({
        kind: input.kind,
        bookId: input.bookId,
        chapterId: input.chapterId,
        label: input.label,
        status: "queued",
        progress: 0,
        queuedAt: at,
        startedAt: null,
        finishedAt: null,
        cancelled: false,
        activeKey: activeKey(input.kind, input.bookId, input.chapterId),
        bulkId: input.bulk?.id ?? null,
        bulkOp: input.bulk?.op ?? null,
        bulkIndex: input.bulk?.index ?? null,
        bulkTotal: input.bulk?.total ?? null,
        bulkScope: input.bulk?.scope ?? null,
        run: input.run ?? {},
      })
      .returning({ id: jobs.id })
      .get();
    appendEvent(tx, id, "Job queued", "info", undefined, at);
    input.onCreated?.(tx, id);
    return { job: getJob(tx, id)!, created: true };
  });
}

/**
 * Take the oldest queued job and mark it running, in one transaction.
 *
 * Nothing here looks at `cancelled`: `requestCancel` is the only writer of that flag and it
 * finishes a queued job on the spot, so a queued row is never a cancelled one. Settling a row
 * here instead would do so behind the runner's back, without the handler's `onSettled`.
 */
export function claimNext(db: Db, at = Date.now()): Job | undefined {
  return db.transaction((tx) => {
    {
      const row = tx
        .select()
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(asc(jobs.id))
        .get();
      if (!row) return undefined;
      tx.update(jobs)
        .set({
          status: "running",
          startedAt: row.startedAt ?? at,
          attempts: row.attempts + 1,
          waitingReason: null,
        })
        .where(eq(jobs.id, row.id))
        .run();
      appendEvent(
        tx,
        row.id,
        row.attempts ? `Job started again (attempt ${row.attempts + 1})` : "Job started",
        "info",
        { queueMs: at - row.queuedAt },
        at,
      );
      return getJob(tx, row.id)!;
    }
  });
}

export function setProgress(db: Db | Tx, id: number, progress: number): void {
  db.update(jobs)
    .set({ progress: Math.max(0, Math.min(100, progress)) })
    .where(eq(jobs.id, id))
    .run();
}

/**
 * Replace the live detail the Queue page opens up.
 *
 * A scripting or narration job's `run` is settled when it is queued and never moves. A build's
 * does: which file it is writing and how many chapters it has laid down are the only account of a
 * run that can last minutes, and the Queue reads them by polling the row.
 */
export function setRun(db: Db | Tx, id: number, run: NonNullable<Job["exportRun"]>): void {
  db.update(jobs)
    .set({ run: { exportRun: run } })
    .where(eq(jobs.id, id))
    .run();
}

/**
 * Record one thing that happened, and keep the log bounded.
 *
 * The oldest events go first once a job has more than `MAX_JOB_EVENTS`, and `dropped_events`
 * counts what is no longer there, so a trimmed log stays honest about it.
 */
export function appendEvent(
  db: Db | Tx,
  jobId: number,
  message: string,
  level: JobEvent["level"] = "info",
  detail?: JobEvent["detail"],
  at = Date.now(),
): void {
  // A job whose book was removed while it ran is gone, and there is nothing left to say it to.
  if (!db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).get()) return;
  const last = db
    .select({ n: max(jobEvents.id) })
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .get()?.n;
  const id = (last ?? 0) + 1;
  db.insert(jobEvents)
    .values({ jobId, id, at, level, message, detail: detail ?? null })
    .run();
  const excess = id - MAX_JOB_EVENTS;
  if (excess <= 0) return;
  // trim to the newest MAX_JOB_EVENTS: ids are dense, so everything at or below `excess` goes
  const dropped = db
    .delete(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), sql`${jobEvents.id} <= ${excess}`))
    .returning({ id: jobEvents.id })
    .all().length;
  if (dropped)
    db.update(jobs)
      .set({ droppedEvents: sql`${jobs.droppedEvents} + ${dropped}` })
      .where(eq(jobs.id, jobId))
      .run();
}

/** Settle a job. Its key is released, so the same work can be asked for again. */
export function finishJob(
  db: Db | Tx,
  id: number,
  status: Extract<JobStatus, "done" | "failed" | "cancelled">,
  at = Date.now(),
  detail?: JobEvent["detail"],
): void {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row || row.finishedAt != null) return;
  db.update(jobs)
    .set({
      status,
      finishedAt: at,
      activeKey: null,
      waitingReason: null,
      ...(status === "done" ? { progress: 100 } : {}),
    })
    .where(eq(jobs.id, id))
    .run();
  appendEvent(
    db,
    id,
    `Job ${status}`,
    status === "failed" ? "error" : "info",
    { elapsedMs: row.startedAt == null ? 0 : at - row.startedAt, ...detail },
    at,
  );
}

/**
 * Ask for a job to stop. Says what state it was in, so the caller knows whether anything is
 * still running that has to notice.
 */
export function requestCancel(
  db: Db,
  id: number,
  at = Date.now(),
): "queued" | "running" | "finished" | "missing" {
  return db.transaction((tx) => {
    const row = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) return "missing";
    if (row.finishedAt != null) return "finished";
    if (!row.cancelled) {
      tx.update(jobs).set({ cancelled: true }).where(eq(jobs.id, id)).run();
      appendEvent(tx, id, "Cancellation requested", "warning", undefined, at);
    }
    if (row.status === "queued") {
      finishJob(tx, id, "cancelled", at);
      return "queued";
    }
    return "running";
  });
}

export type SettledStatus = Extract<JobStatus, "done" | "failed" | "cancelled">;

/**
 * Put a job the process died holding back in the queue — or give up on it.
 *
 * A row still `running` when nothing is running is a job that was interrupted: the server was
 * stopped or crashed with it in flight. It is queued again so the work is not silently lost, up
 * to `maxAttempts` starts in all, because a job that takes the process down every time must not
 * be allowed to do so forever. One that was already being cancelled is finished as cancelled. The
 * jobs settled here are returned so the runner can give their handlers the last word.
 */
export function recoverInterrupted(
  db: Db,
  { maxAttempts = 2, at = Date.now() }: { maxAttempts?: number; at?: number } = {},
): { requeued: number[]; settled: { id: number; status: SettledStatus }[] } {
  return db.transaction((tx) => {
    const rows = tx.select().from(jobs).where(eq(jobs.status, "running")).all();
    const requeued: number[] = [];
    const settled: { id: number; status: SettledStatus }[] = [];
    for (const row of rows) {
      if (row.cancelled || row.attempts >= maxAttempts) {
        const status = row.cancelled ? "cancelled" : "failed";
        appendEvent(
          tx,
          row.id,
          row.cancelled
            ? "The server restarted while this was stopping"
            : `The server restarted while this ran, and it had already been started ${row.attempts} times`,
          "error",
          undefined,
          at,
        );
        finishJob(tx, row.id, status, at);
        settled.push({ id: row.id, status });
        continue;
      }
      tx.update(jobs)
        .set({ status: "queued", progress: 0, waitingReason: null })
        .where(eq(jobs.id, row.id))
        .run();
      appendEvent(
        tx,
        row.id,
        "The server restarted while this ran; queued again",
        "warning",
        undefined,
        at,
      );
      requeued.push(row.id);
    }
    return { requeued, settled };
  });
}

/** Take a finished job out of the history. A live one stays: cancel it first. */
export function removeJob(db: Db, id: number): boolean {
  return (
    db
      .delete(jobs)
      .where(and(eq(jobs.id, id), isNotNull(jobs.finishedAt)))
      .returning({ id: jobs.id })
      .all().length > 0
  );
}

/** Clear the history. Returns how many went. */
export function clearFinished(db: Db): number {
  return db.delete(jobs).where(isNotNull(jobs.finishedAt)).returning({ id: jobs.id }).all().length;
}

/** The most recent jobs first, for a summary line. */
export function recentJobs(db: Db, limit: number): Job[] {
  return withEvents(db, db.select().from(jobs).orderBy(desc(jobs.id)).limit(limit).all());
}
