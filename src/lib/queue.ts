// The order the queue runs in, as the browser lists it. The server's claim (`claimNext`) is the
// same rule in SQL: the highest priority first, then the oldest.
import type { Job } from "@/types";

export const byRunOrder = (a: Job, b: Job): number =>
  (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id;

/** A stretch of the queue that runs back to back: one job, or the next jobs of one bulk run. */
export interface UpNextGroup {
  /** where its first job stands in the run order, 1 = runs next */
  position: number;
  jobs: Job[];
}

// The waiting jobs in run order, a bulk run's consecutive jobs folded into one group. Only
// consecutive ones: a run split by "Run next" is two groups, so every position stays the real one.
export function upNextGroups(queued: Job[]): UpNextGroup[] {
  const groups: UpNextGroup[] = [];
  [...queued].sort(byRunOrder).forEach((job, i) => {
    const last = groups.at(-1);
    if (job.bulk && last?.jobs[0].bulk?.id === job.bulk.id) last.jobs.push(job);
    else groups.push({ position: i + 1, jobs: [job] });
  });
  return groups;
}
