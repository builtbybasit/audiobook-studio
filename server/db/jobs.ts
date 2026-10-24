// Every read and write the queue makes; a row goes out as the frontend's `Job` through `toJob`.
// `active_key` is the duplicate-request rule: `kind:book:chapter` while live, NULL once finished,
// under a unique index (SQLite treats NULLs as distinct), so the same work cannot be queued twice.
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  max,
  sql,
} from "drizzle-orm";

import type { Job, JobEvent, JobKind, JobStatus } from "@/types";
import type { Db, Tx } from "~/db/client";
import { jobEvents, jobs } from "~/db/schema";
import { toJob } from "~/db/rows";

/** Events kept per job; the frontend keeps the same number. */
export const MAX_JOB_EVENTS = 1000;

export const activeKey = (kind: JobKind, bookId: string, chapterId: number | null): string =>
  `${kind}:${bookId}:${chapterId ?? "book"}`;

export interface EnqueueInput {
  kind: JobKind;
  bookId: string;
  chapterId: number | null;
  label: string;
  bulk?: Job["bulk"];
  run?: Pick<Job, "scriptRun" | "narrationRun" | "exportRun" | "transcribeRun" | "effectsRun">;
  /**
   * Runs in the same transaction, only when the job is created, so a change like a chapter marked
   * `queued` cannot land after the worker has picked the job up.
   */
  onCreated?(tx: Tx, id: number): void;
}

export type Enqueued = { job: Job; created: true } | { job: Job; created: false };

/** Finished jobs `GET /jobs` sends by default: one whole-book run at 900 chapters fits. */
export const JOB_HISTORY = 1000;

function eventsOf(db: Db | Tx, jobId: number) {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).all();
}

const withEvents = (db: Db | Tx, row: typeof jobs.$inferSelect): Job =>
  toJob(row, eventsOf(db, row.id));

export function getJob(db: Db | Tx, id: number): Job | undefined {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  return row ? withEvents(db, row) : undefined;
}

/** Queued and running, oldest first, without their events. */
export function liveJobs(db: Db | Tx, bookId?: string): Job[] {
  return db
    .select()
    .from(jobs)
    .where(and(bookId ? eq(jobs.bookId, bookId) : undefined, isNull(jobs.finishedAt)))
    .orderBy(asc(jobs.id))
    .all()
    .map((r) => toJob(r));
}

/**
 * Every live job and the `history` latest finished, oldest first. Polled, so no events (`getJob`
 * has them) except a failed job's first error, which says why it failed.
 */
export function listJobs(
  db: Db | Tx,
  { bookId, history = JOB_HISTORY }: { bookId?: string; history?: number } = {},
): Job[] {
  const book = bookId ? eq(jobs.bookId, bookId) : undefined;
  const finished = db
    .select()
    .from(jobs)
    .where(and(book, isNotNull(jobs.finishedAt)))
    .orderBy(desc(jobs.finishedAt), desc(jobs.id))
    .limit(history)
    .all();
  const failed = finished.filter((r) => r.status === "failed").map((r) => r.id);
  // one row per job: SQLite takes the bare columns from the row `min` picked
  const firstError = new Map(
    (failed.length
      ? db
          .select({ ...getTableColumns(jobEvents), id: sql<number>`min(${jobEvents.id})` })
          .from(jobEvents)
          .where(and(inArray(jobEvents.jobId, failed), eq(jobEvents.level, "error")))
          .groupBy(jobEvents.jobId)
          .all()
      : []
    ).map((e) => [e.jobId, e]),
  );
  const done = finished.map((r) => {
    const error = firstError.get(r.id);
    return toJob(r, error ? [error] : []);
  });
  return [...liveJobs(db, bookId), ...done].sort((a, b) => a.id - b.id);
}

/**
 * Rewrite a book's live `active_key`s after a renumbering: `chapter_id` follows by foreign key,
 * but the key string does not. Keys are parked on the job's own id first, since the column is
 * unique and rewriting in place would collide mid-way.
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
  return row ? withEvents(db, row) : undefined;
}

export function nextRunId(db: Db | Tx): number {
  return (
    (db
      .select({ n: max(jobs.bulkId) })
      .from(jobs)
      .get()?.n ?? 0) + 1
  );
}

/** Put a job in the queue, or hand back the live one already doing this work (`created: false`). */
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
        // held against the book's cap from the moment the job exists
        reserved: input.run?.scriptRun?.reserved ?? input.run?.narrationRun?.reserved ?? 0,
      })
      .returning({ id: jobs.id })
      .get();
    appendEvent(tx, id, "Job queued", "info", undefined, at);
    input.onCreated?.(tx, id);
    return { job: getJob(tx, id)!, created: true };
  });
}

/**
 * Move these queued jobs ahead of everything waiting, as a block keeping their own order; returns
 * the ids that moved.
 */
export function runNext(db: Db, ids: readonly number[]): number[] {
  if (!ids.length) return [];
  return db.transaction((tx) => {
    const top =
      tx
        .select({ p: max(jobs.priority) })
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .get()?.p ?? 0;
    return tx
      .update(jobs)
      .set({ priority: top + 1 })
      .where(and(inArray(jobs.id, [...ids]), eq(jobs.status, "queued")))
      .returning({ id: jobs.id })
      .all()
      .map((r) => r.id);
  });
}

type Lane = Pick<Job, "id" | "kind" | "bookId" | "chapterId">;

/**
 * The first of `queued` (in claim order) that nothing running or ahead of it holds back. Per book:
 * one job of each kind, a chapter's jobs in turn, a whole-book job alone. A job held back holds
 * its own keys, so nothing behind it on the same key overtakes it.
 */
export function firstReady(running: readonly Lane[], queued: readonly Lane[]): Lane | undefined {
  // `some:` = a job of the book is out; `all:` = a whole-book one is
  const holds = (j: Lane): string[] =>
    j.chapterId == null
      ? [`some:${j.bookId}`, `all:${j.bookId}`]
      : [`some:${j.bookId}`, `${j.kind}:${j.bookId}`, `chapter:${j.bookId}:${j.chapterId}`];
  const needs = (j: Lane): string[] =>
    j.chapterId == null
      ? [`some:${j.bookId}`]
      : [`all:${j.bookId}`, `${j.kind}:${j.bookId}`, `chapter:${j.bookId}:${j.chapterId}`];
  const held = new Set(running.flatMap(holds));
  for (const j of queued) {
    if (!needs(j).some((k) => held.has(k))) return j;
    for (const k of holds(j)) held.add(k);
  }
  return undefined;
}

/**
 * Claim the next ready job (`firstReady`, over highest priority then oldest: `byRunOrder` on the
 * page) and mark it running. `cancelled` is not checked: `requestCancel` finishes a queued job on
 * the spot.
 */
export function claimNext(db: Db, at = Date.now()): Job | undefined {
  return db.transaction((tx) => {
    {
      const live = tx
        .select({
          id: jobs.id,
          kind: jobs.kind,
          bookId: jobs.bookId,
          chapterId: jobs.chapterId,
          status: jobs.status,
        })
        .from(jobs)
        .where(inArray(jobs.status, ["queued", "running"]))
        .orderBy(desc(jobs.priority), asc(jobs.id))
        .all();
      const ready = firstReady(
        live.filter((j) => j.status === "running"),
        live.filter((j) => j.status === "queued"),
      );
      if (!ready) return undefined;
      const row = tx.select().from(jobs).where(eq(jobs.id, ready.id)).get()!;
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
        row.attempts
          ? `Job started again (attempt ${row.attempts + 1})`
          : row.startedAt != null
            ? "Job started again"
            : "Job started",
        "info",
        { queueMs: at - row.queuedAt },
        at,
      );
      return getJob(tx, row.id)!;
    }
  });
}

/**
 * Give back the attempt a clean stop interrupted: `attempts` counts only starts that ended with
 * the process dying. The row stays `running` for `recoverInterrupted` to find.
 */
export function handBack(db: Db, id: number): void {
  db.update(jobs)
    .set({ attempts: sql`max(${jobs.attempts} - 1, 0)`, progress: 0 })
    .where(eq(jobs.id, id))
    .run();
}

export function setProgress(db: Db | Tx, id: number, progress: number): void {
  db.update(jobs)
    .set({ progress: Math.max(0, Math.min(100, progress)) })
    .where(eq(jobs.id, id))
    .run();
}

/** Replace a build's live detail, which the Queue reads by polling the row. */
export function setRun(db: Db | Tx, id: number, run: NonNullable<Job["exportRun"]>): void {
  db.update(jobs)
    .set({ run: { exportRun: run } })
    .where(eq(jobs.id, id))
    .run();
}

/** Replace a scripting job's request counts, and its reservation with them. */
export function setScriptRun(db: Db | Tx, id: number, run: NonNullable<Job["scriptRun"]>): void {
  db.update(jobs)
    .set({ run: { scriptRun: run }, reserved: run.reserved })
    .where(eq(jobs.id, id))
    .run();
}

export function setTranscribeRun(
  db: Db | Tx,
  id: number,
  run: NonNullable<Job["transcribeRun"]>,
): void {
  db.update(jobs)
    .set({ run: { transcribeRun: run } })
    .where(eq(jobs.id, id))
    .run();
}

/** Change what a job holds against its book's cap, in the column and in the run detail. */
export function setReserved(db: Db | Tx, id: number, reserved: number): void {
  const row = db.select({ run: jobs.run }).from(jobs).where(eq(jobs.id, id)).get();
  if (!row) return;
  db.update(jobs).set(holding(row.run, reserved)).where(eq(jobs.id, id)).run();
}

function holding(run: (typeof jobs.$inferSelect)["run"], reserved: number) {
  const r = run ?? {};
  return {
    reserved,
    run: r.scriptRun
      ? { scriptRun: { ...r.scriptRun, reserved } }
      : r.narrationRun
        ? { narrationRun: { ...r.narrationRun, reserved } }
        : r,
  };
}

/** Log an event; past `MAX_JOB_EVENTS` the oldest go and `dropped_events` counts them. */
export function appendEvent(
  db: Db | Tx,
  jobId: number,
  message: string,
  level: JobEvent["level"] = "info",
  detail?: JobEvent["detail"],
  at = Date.now(),
): void {
  // the job's book may have been removed while it ran
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

/** Settle a job: its key is released and its reservation zeroed, however it ended. */
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
      ...holding(row.run, 0),
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

/** Ask for a job to stop; a queued one finishes now. Returns the state it was in. */
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
 * At boot, requeue each job still `running`, up to `maxAttempts` starts so a job that crashes the
 * process cannot loop forever; past that, or if it was being cancelled, settle it. Settled jobs
 * are returned so the runner can call their handlers.
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
            : `The server restarted while this ran, and it had already been cut off ${row.attempts} times`,
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

/** Finished jobs only; a live one must be cancelled first. */
export function removeJob(db: Db, id: number): boolean {
  return (
    db
      .delete(jobs)
      .where(and(eq(jobs.id, id), isNotNull(jobs.finishedAt)))
      .returning({ id: jobs.id })
      .all().length > 0
  );
}

export function clearFinished(db: Db): number {
  return db.delete(jobs).where(isNotNull(jobs.finishedAt)).returning({ id: jobs.id }).all().length;
}
