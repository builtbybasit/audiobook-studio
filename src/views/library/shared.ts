// The one thing worth doing on this book, as a verb and where it happens.
//
// Both surfaces that answer "what next" read this: the shelf card next to its cover, and the book
// overview's banner. They used to each walk their own chain, so the same book could be told to
// re-narrate a stale chapter on the shelf and to review a new speaker on its own overview — two
// answers, both true, neither complete. One chain, two renderings: `label` is the button, `text`
// is the sentence the overview has room for.
//
// Pure over the counts, so the card, the overview and the test can agree on the words.
import type { BookProgress, ExportUpdate } from "@/types";

export interface NextStep {
  /** the verb, short enough for a card chip and a button */
  label: string;
  /** one sentence saying why, for the surfaces with room for it */
  text: string;
  /** the stage path segment under /book/:id — "" is the overview */
  to: "scripting" | "narration" | "export" | "contents" | "cast" | "";
  tone: "amber" | "sky" | "violet" | "emerald" | "zinc" | "red";
}

/** Everything the chain needs that isn't a chapter count. */
export interface NextStepContext {
  failedScripting: number;
  failedNarration: number;
  /** speakers first seen in a re-script and not yet reviewed — usually aliases to merge */
  unreviewed: number;
  /** main cast still borrowing the Narrator's voice */
  unvoiced: number;
  /** finished audiobooks */
  exports: number;
  behind: boolean;
  building: boolean;
}

export function nextStepOf(p: BookProgress, extra: NextStepContext): NextStep {
  const n = (count: number, one: string, many = one + "s") =>
    `${count} ${count === 1 ? one : many}`;
  // Broken work first, then work that needs a decision, then work that just needs doing. A retry
  // outranks a review on purpose: the shelf's "needs attention" filter keys on the red tone, so
  // a book with a failed chapter has to stay findable even when it also has a speaker to review.
  if (!p.total)
    return {
      label: "Nothing included — review contents",
      text: "Every chapter is excluded, so there is nothing to script or narrate.",
      to: "contents",
      tone: "zinc",
    };
  if (p.scripted === 0)
    return {
      label: "Start scripting",
      text: "Nothing is scripted yet. Run scripting on the first few chapters to extract the cast.",
      to: "scripting",
      tone: "amber",
    };
  if (extra.failedScripting)
    return {
      label: `Retry ${n(extra.failedScripting, "failed chapter")}`,
      text: `${n(extra.failedScripting, "chapter")} failed scripting.`,
      to: "scripting",
      tone: "red",
    };
  if (extra.unreviewed)
    return {
      label: "Review cast",
      text: `${n(extra.unreviewed, "newly detected speaker")} ${
        extra.unreviewed === 1 ? "needs" : "need"
      } review — probably aliases to merge.`,
      to: "cast",
      tone: "amber",
    };
  if (p.fallback)
    return {
      label: "Inspect fallbacks",
      text: `${n(p.fallback, "chapter")} kept a chunk as plain narration because it didn’t verify.`,
      to: "scripting",
      tone: "amber",
    };
  if (extra.unvoiced)
    return {
      label: "Assign voices",
      text: `${n(extra.unvoiced, "main character")} still ${
        extra.unvoiced === 1 ? "uses" : "use"
      } the Narrator’s voice.`,
      to: "narration",
      tone: "sky",
    };
  if (p.stale)
    return {
      label: `Re-narrate ${n(p.stale, "stale chapter")}`,
      text: `${n(p.stale, "chapter")} edited after narration — audio is stale.`,
      to: "narration",
      tone: "amber",
    };
  if (extra.failedNarration)
    return {
      label: `Retry ${n(extra.failedNarration, "failed narration")}`,
      text: `${n(extra.failedNarration, "chapter")} have failed segments.`,
      to: "narration",
      tone: "red",
    };
  if (p.narrated < p.scripted)
    return {
      label: `Narrate ${n(p.scripted - p.narrated, "chapter")}`,
      text: `${n(p.scripted - p.narrated, "scripted chapter")} ${
        p.scripted - p.narrated === 1 ? "is" : "are"
      } not narrated yet.`,
      to: "narration",
      tone: "sky",
    };
  if (p.scripted < p.total)
    return {
      label: `Script ${p.total - p.scripted} more`,
      text: `${n(p.total - p.scripted, "chapter")} still to script.`,
      to: "scripting",
      tone: "amber",
    };
  if (extra.building)
    return {
      label: "Building the audiobook…",
      text: "The audiobook is being built.",
      to: "export",
      tone: "violet",
    };
  if (!extra.exports)
    return {
      label: "Build the audiobook",
      text: "Everything is narrated. Build the audiobook.",
      to: "export",
      tone: "violet",
    };
  if (extra.behind)
    return {
      label: "Update the audiobook",
      text: "New chapters narrated since the last audiobook build.",
      to: "export",
      tone: "violet",
    };
  return {
    label: "Audiobook up to date",
    text: "This book is complete and exported.",
    to: "export",
    tone: "emerald",
  };
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
