// The order the queue runs in, as the browser lists it. The server's claim (`claimNext`) is the
// same rule in SQL: the highest priority first, then the oldest.
import type { Eta, Job, JobKind } from "@/types";

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

// "Narrate · ch 2", "Script · ch 14 · OpenAI". The server's label omits the chapter because its
// reading number moves when a chapter is skipped or kept.
export function jobLabel(label: string, chapter: string | undefined): string {
  if (!chapter) return label;
  const [verb, ...rest] = label.split(" · ");
  return [verb, chapter, ...rest].join(" · ");
}

/** a kind's guess before any of its jobs has finished, in seconds */
const FIRST_GUESS: Record<JobKind, number> = {
  scripting: 25,
  narration: 60,
  export: 120,
  transcribe: 15,
  effects: 120,
  facts: 20,
  profiles: 60,
};
const RECENT = 20;

/**
 * When the queue drains: each book's jobs one after another, books side by side. A job takes the
 * median of its kind's last finished ones, so one that hung for hours doesn't skew it.
 */
export function queueEta(jobs: readonly Job[], now = Date.now()): Eta | null {
  const took: Partial<Record<JobKind, number[]>> = {};
  for (const j of [...jobs].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)))
    if (j.status === "done" && j.startedAt && j.finishedAt)
      (took[j.kind] ??= []).push((j.finishedAt - j.startedAt) / 1000);
  const typical = (k: JobKind): number => {
    const recent = (took[k] ?? []).slice(-RECENT).sort((a, b) => a - b);
    if (!recent.length) return FIRST_GUESS[k] ?? 60;
    const mid = recent.length >> 1;
    return recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
  };
  const perBook: Record<string, number> = {};
  for (const j of jobs) {
    if (j.status !== "running" && j.status !== "queued") continue;
    const left = j.status === "queued" ? 1 : 1 - (j.progress ?? 0) / 100;
    perBook[j.bookId] = (perBook[j.bookId] ?? 0) + typical(j.kind) * left;
  }
  const books = Object.keys(perBook).length;
  if (!books) return null;
  const seconds = Math.max(...Object.values(perBook));
  return { seconds, at: now + seconds * 1000, books };
}
