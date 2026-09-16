// What the contents review's list, filters and chips share.
import { stateOf } from "@/lib/contents";
import type { Chapter, ContentState, NoticeKind } from "@/types";

export type ContentsFilter = "all" | "included" | "suggested" | "review" | "skipped";
export const FILTER_KEYS: ContentsFilter[] = ["all", "included", "suggested", "review", "skipped"];

export const FILTER_LABEL: Record<ContentsFilter, string> = {
  all: "All",
  included: "Included",
  suggested: "Suggested skips",
  review: "Needs review",
  skipped: "Skipped",
};

/** The chip beside a title, for the states that are worth a word. */
export const STATE_CHIP: Record<ContentState, { label: string; cls: string } | null> = {
  included: null,
  suggested: {
    label: "Suggested skip",
    cls: "border-amber-400/70 bg-amber-400/10 text-amber-700 dark:text-amber-300",
  },
  review: {
    label: "Needs review",
    cls: "border-violet-400/70 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  kept: {
    label: "Kept",
    cls: "border-emerald-400/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  skipped: {
    label: "Skipped",
    cls: "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
  },
};

export function passes(c: Chapter, filter: ContentsFilter, kind: NoticeKind | null, q: string) {
  const s = stateOf(c);
  if (filter === "included" && s === "skipped") return false;
  if (filter === "suggested" && s !== "suggested") return false;
  if (filter === "review" && s !== "review") return false;
  if (filter === "skipped" && s !== "skipped") return false;
  if (kind && c.note?.kind !== kind) return false;
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return (
    c.title.toLowerCase().includes(needle) ||
    String(c.id) === needle ||
    (c.note?.reason.toLowerCase().includes(needle) ?? false)
  );
}

export const words = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k words` : `${n} words`;
