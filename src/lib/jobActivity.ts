import type { Job, JobEvent } from "@/types";
import { sanitize } from "@/lib/endpoints";

export const MAX_JOB_EVENTS = 1000;

/** Store only explicit diagnostic fields, never provider payloads or credentials. */
export function logJob(
  job: Job,
  message: string,
  level: JobEvent["level"] = "info",
  detail?: JobEvent["detail"],
): void {
  const events = (job.activity ??= []);
  events.push({
    id: (events.at(-1)?.id ?? 0) + 1,
    at: Date.now(),
    level,
    message: sanitize(message),
    ...(detail
      ? {
          detail: Object.fromEntries(
            Object.entries(detail).map(([k, v]) => [
              k,
              /key|secret|authorization|token(?!s)/i.test(k)
                ? "[redacted]"
                : typeof v === "string"
                  ? sanitize(v)
                  : v,
            ]),
          ),
        }
      : {}),
  });
  if (events.length > MAX_JOB_EVENTS) {
    const count = events.length - MAX_JOB_EVENTS;
    events.splice(0, count);
    job.droppedEvents = (job.droppedEvents ?? 0) + count;
  }
}

/** Log transitions only, not each scheduler tick. */
export function jobWaiting(job: Job, reason: string): void {
  if ((job.waitingReason ?? "") === reason) return;
  job.waitingReason = reason;
  logJob(job, reason ? `Waiting: ${reason}` : "Dispatch is available again");
}

export function startJob(job: Job): void {
  job.status = "running";
  if (job.startedAt !== null) return;
  job.startedAt = Date.now();
  logJob(job, "Job started", "info", { queueMs: job.startedAt - job.queuedAt });
}

export function jobDiagnostics(job: Job): string {
  // Deliberate allowlist: the job also contains a connection snapshot which must not be copied.
  return JSON.stringify(
    {
      simulated: true,
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      droppedEvents: job.droppedEvents ?? 0,
      activity: job.activity ?? [],
    },
    null,
    2,
  );
}
