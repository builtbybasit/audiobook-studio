// Queue history from "earlier today", so the Queue page opens with done / failed / cancelled rows
// to act on rather than an empty list.
//
// Job ids come from the store's own sequence, which is passed in: the seeded rows and everything
// queued afterwards share one numbering, so "retry this job" addresses the same row either way.
import type { Job, JobKind, JobStatus } from "@/types";

const ago = (min: number): number => Date.now() - min * 60000;

export function makeJobHistory(nextId: () => number): Job[] {
  const mk = (
    kind: JobKind,
    bookId: string,
    chapterId: number | null,
    label: string,
    status: JobStatus,
    startMin: number,
    secs: number,
  ): Job => ({
    id: nextId(),
    kind,
    bookId,
    chapterId,
    label,
    status,
    progress: status === "done" ? 100 : status === "failed" ? 100 : 40,
    queuedAt: ago(startMin + 1),
    startedAt: ago(startMin),
    finishedAt: ago(startMin) + secs * 1000,
    cancelled: status === "cancelled",
  });
  return [
    mk("export", "starforge", null, "Build M4B · 18 ch", "done", 95, 214),
    mk("narration", "starforge", 18, "Narrate · ch 18", "done", 118, 71),
    mk("narration", "starforge", 17, "Narrate · ch 17", "done", 121, 64),
    mk("scripting", "cliche", 12, "Script · ch 12", "done", 41, 26),
    mk("scripting", "cliche", 11, "Script · ch 11", "done", 42, 24),
    mk("narration", "cliche", 4, "Narrate · ch 4", "failed", 33, 58),
    mk("narration", "cliche", 3, "Narrate · ch 3", "done", 35, 61),
    mk("scripting", "drowned", 2, "Script · ch 2", "failed", 12, 31),
    mk("scripting", "drowned", 1, "Script · ch 1", "done", 13, 27),
    mk("narration", "drowned", 1, "Narrate · ch 1", "cancelled", 9, 12),
  ];
}
