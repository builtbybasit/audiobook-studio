// Everything a shelf can say about one book, gathered once. Each layout decides what to show and
// where; none of them recompute it. Read-only over the stores.
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { nextStepOf, plural, updateReason, type NextStep } from "@/views/library/shared";
import type { BookProgress, ContentsSummary, ExportItem } from "@/types";

export interface BookFacts {
  progress: BookProgress;
  contents: ContentsSummary;
  next: NextStep;
  failedScripting: number;
  failedNarration: number;
  /** "Scripting 3 chapters · Narrating 2 chapters", or "" */
  activity: string;
  running: boolean;
  failedJobs: number;
  /** the latest finished audiobook, if any */
  latest: ExportItem | null;
  /** the latest audiobook no longer matches the book … */
  behind: boolean;
  /** … and this is why, e.g. "3 chapters not in it yet" */
  behindWhy: string;
  building: boolean;
}

/** The facts as they stand now. Plain, so a list can gather them for every book in one pass. */
export function bookFacts(id: string): BookFacts {
  const exportsStore = useExportsStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();

  const chapters = libraryStore.chaptersOf(id);
  const progress = libraryStore.progress(id);
  const contents = libraryStore.contentsOf(id);
  const failedScripting = chapters.filter((c) => c.scripting === "failed").length;
  const failedNarration = chapters.filter((c) => c.narration === "failed").length;
  const all = exportsStore.exportsOf(id);
  const done = all.filter((e) => e.status === "done");
  const latest = done.length ? done.reduce((a, b) => (b.version > a.version ? b : a)) : null;
  const update = latest ? exportsStore.exportUpdateFor(latest) : null;
  const behind = !!update?.needed;
  const building = all.some((e) => e.status === "building");
  const active = jobsStore.activeJobs.filter((j) => j.bookId === id);
  const byKind = new Map<string, number>();
  for (const j of active) byKind.set(j.kind, (byKind.get(j.kind) ?? 0) + 1);
  const verb: Record<string, string> = { scripting: "Scripting", narration: "Narrating" };
  const activity = [...byKind]
    .map(([k, n]) =>
      k === "export" ? "Building the audiobook" : `${verb[k] ?? k} ${plural(n, "chapter")}`,
    )
    .join(" · ");
  return {
    progress,
    contents,
    next: nextStepOf(progress, {
      failedScripting,
      failedNarration,
      exports: done.length,
      behind,
      building,
    }),
    failedScripting,
    failedNarration,
    activity,
    running: active.length > 0,
    failedJobs: jobsStore.jobs.filter((j) => j.bookId === id && j.status === "failed").length,
    latest,
    behind,
    behindWhy: update && behind ? updateReason(update) : "",
    building,
  };
}

export function useBookFacts(bookId: MaybeRefOrGetter<string>): ComputedRef<BookFacts> {
  return computed(() => bookFacts(toValue(bookId)));
}
