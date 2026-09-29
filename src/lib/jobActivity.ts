import type { Job } from "@/types";

export function jobDiagnostics(job: Job): string {
  // Deliberate allowlist: the job also contains a connection snapshot which must not be copied.
  return JSON.stringify(
    {
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
