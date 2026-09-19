// Queue jobs, between rows and the shapes the Queue page reads.
import type { Job, JobEvent } from "@/types";
import type { jobEvents, jobs } from "~/db/schema";

type JobRow = typeof jobs.$inferSelect;
type EventRow = typeof jobEvents.$inferSelect;

export function toJob(row: JobRow, events: readonly EventRow[] = []): Job {
  const j: Job = {
    id: row.id,
    kind: row.kind,
    bookId: row.bookId,
    chapterId: row.chapterId,
    label: row.label,
    status: row.status,
    progress: row.progress,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    cancelled: row.cancelled,
  };
  if (row.waitingReason != null) j.waitingReason = row.waitingReason;
  if (row.bulkId != null)
    j.bulk = {
      id: row.bulkId,
      op: row.bulkOp ?? "",
      index: row.bulkIndex ?? 0,
      total: row.bulkTotal ?? 0,
      ...(row.bulkScope != null ? { scope: row.bulkScope } : {}),
    };
  if (row.run?.scriptRun) j.scriptRun = row.run.scriptRun;
  if (row.run?.narrationRun) j.narrationRun = row.run.narrationRun;
  if (row.run?.exportRun) j.exportRun = row.run.exportRun;
  if (events.length)
    j.activity = [...events]
      .sort((a, b) => a.id - b.id)
      .map((e): JobEvent => ({
        id: e.id,
        at: e.at,
        level: e.level,
        message: e.message,
        ...(e.detail != null ? { detail: e.detail } : {}),
      }));
  if (row.droppedEvents) j.droppedEvents = row.droppedEvents;
  return j;
}

/**
 * What this job is holding against the book's cap.
 *
 * Read off whichever run detail the job carries, and stored as a column so the budget gate can sum
 * it across unfinished jobs without opening every job's detail.
 */
const reservedOf = (j: Job): number => j.scriptRun?.reserved ?? j.narrationRun?.reserved ?? 0;

const estimatedOf = (j: Job): number | null =>
  j.scriptRun?.estimated ?? j.narrationRun?.estimated ?? null;

export function jobValues(j: Job): typeof jobs.$inferInsert {
  return {
    id: j.id,
    kind: j.kind,
    bookId: j.bookId,
    chapterId: j.chapterId,
    label: j.label,
    status: j.status,
    progress: j.progress,
    queuedAt: j.queuedAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    cancelled: j.cancelled,
    waitingReason: j.waitingReason ?? null,
    bulkId: j.bulk?.id ?? null,
    bulkOp: j.bulk?.op ?? null,
    bulkIndex: j.bulk?.index ?? null,
    bulkTotal: j.bulk?.total ?? null,
    bulkScope: j.bulk?.scope ?? null,
    reserved: reservedOf(j),
    estimated: estimatedOf(j),
    run: {
      ...(j.scriptRun ? { scriptRun: j.scriptRun } : {}),
      ...(j.narrationRun ? { narrationRun: j.narrationRun } : {}),
      ...(j.exportRun ? { exportRun: j.exportRun } : {}),
    },
    droppedEvents: j.droppedEvents ?? 0,
  };
}

export const jobEventValues = (jobId: number, e: JobEvent): typeof jobEvents.$inferInsert => ({
  jobId,
  id: e.id,
  at: e.at,
  level: e.level,
  message: e.message,
  detail: e.detail ?? null,
});
