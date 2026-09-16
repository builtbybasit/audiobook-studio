// What a book card says next to its cover: the one thing worth doing on this book, as a verb, and
// where it happens. Pure over the counts, so the card and the test can agree on the words.
import type { BookProgress, ExportUpdate } from "@/types";

export interface NextStep {
  label: string;
  /** the stage path segment under /book/:id — "" is the overview */
  to: "scripting" | "narration" | "export" | "contents" | "";
  tone: "amber" | "sky" | "violet" | "emerald" | "zinc" | "red";
}

export function nextStepOf(
  p: BookProgress,
  extra: {
    failedScripting: number;
    failedNarration: number;
    exports: number;
    behind: boolean;
    building: boolean;
  },
): NextStep {
  if (!p.total)
    return { label: "Nothing included — review contents", to: "contents", tone: "zinc" };
  if (p.scripted === 0) return { label: "Start scripting", to: "scripting", tone: "amber" };
  if (extra.failedScripting)
    return {
      label: `Retry ${extra.failedScripting} failed chapter${extra.failedScripting === 1 ? "" : "s"}`,
      to: "scripting",
      tone: "red",
    };
  if (p.stale)
    return {
      label: `Re-narrate ${p.stale} stale chapter${p.stale === 1 ? "" : "s"}`,
      to: "narration",
      tone: "amber",
    };
  if (extra.failedNarration)
    return {
      label: `Retry ${extra.failedNarration} failed narration${extra.failedNarration === 1 ? "" : "s"}`,
      to: "narration",
      tone: "red",
    };
  if (p.narrated < p.scripted)
    return { label: `Narrate ${p.scripted - p.narrated} chapters`, to: "narration", tone: "sky" };
  if (p.scripted < p.total)
    return { label: `Script ${p.total - p.scripted} more`, to: "scripting", tone: "amber" };
  if (extra.building) return { label: "Building the audiobook…", to: "export", tone: "violet" };
  if (!extra.exports) return { label: "Build the audiobook", to: "export", tone: "violet" };
  if (extra.behind) return { label: "Update the audiobook", to: "export", tone: "violet" };
  return { label: "Audiobook up to date", to: "export", tone: "emerald" };
}

export const TONE: Record<NextStep["tone"], string> = {
  amber:
    "border-amber-300 bg-amber-400/10 text-amber-800 hover:bg-amber-400/20 dark:border-amber-500/40 dark:text-amber-200",
  sky: "border-sky-300 bg-sky-400/10 text-sky-800 hover:bg-sky-400/20 dark:border-sky-500/40 dark:text-sky-200",
  violet:
    "border-violet-300 bg-violet-500/10 text-violet-800 hover:bg-violet-500/20 dark:border-violet-500/40 dark:text-violet-200",
  emerald:
    "border-emerald-300 bg-emerald-500/10 text-emerald-800 hover:bg-emerald-500/20 dark:border-emerald-500/40 dark:text-emerald-200",
  zinc: "border-zinc-300 bg-zinc-500/5 text-zinc-700 hover:bg-zinc-500/10 dark:border-zinc-700 dark:text-zinc-300",
  red: "border-red-300 bg-red-500/10 text-red-800 hover:bg-red-500/20 dark:border-red-500/40 dark:text-red-200",
};

/**
 * Why a finished audiobook no longer matches the book, in one short phrase a card can carry:
 * the most consequential reason first, and the count with it. "" when it still matches.
 */
export function updateReason(
  u: Pick<ExportUpdate, "added" | "changed" | "stale" | "missing" | "settings">,
): string {
  const n = (ids: number[], what: string, one = what) =>
    `${ids.length} chapter${ids.length === 1 ? "" : "s"} ${ids.length === 1 ? one : what}`;
  if (u.missing.length) return n(u.missing, "lost their audio", "lost its audio");
  if (u.added.length) return n(u.added, "not in it yet");
  if (u.changed.length) return n(u.changed, "re-narrated since");
  if (u.stale.length) return n(u.stale, "stale");
  if (u.settings.length) return "output settings changed";
  return "";
}

/** A running time the way a listener says it: 4h 12m, or 47 min. */
export const hours = (s: number): string =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
    : `${Math.max(1, Math.round(s / 60))} min`;

export const plural = (n: number, one: string, many = one + "s"): string =>
  `${n} ${n === 1 ? one : many}`;
