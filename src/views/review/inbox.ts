// Every decision one book is waiting on, in one list.
//
// A pending decision is something only a person can settle: a retake to compare against the clip in
// the book, a flagged clip, a speaker that might be an alias, a chunk that didn't verify, an
// expression whose position drifted, a chapter the import wasn't sure about, a run that failed.
// Each already has a small count on the page it belongs to, and each of those pages is somewhere
// else — so the overview could say "review cast" while four retakes sat unheard two pages away, and
// Export's "audio review is unfinished" only spoke up at the very end.
//
// This gathers them all, says where each one is, and hands back a link that lands on the row itself
// rather than at the top of the page it lives on. Read-only over the stores, like `bookFacts`:
// nothing here decides anything, and a decision settled anywhere leaves the list on the next read.
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";

import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import type { RouteLocationRaw } from "vue-router";
import { flagText } from "@/lib/scriptReview";
import { plural } from "@/views/library/shared";
import type { Job } from "@/types";

/** The stage a decision belongs to, which is also the page it is settled on. */
export type DecisionKind =
  | "failed"
  | "contents"
  | "unverified"
  | "speaker"
  | "merge"
  | "expression"
  | "flagged"
  | "retake";

export interface Decision {
  /** stable across a re-read, so the list can key on it and a jump can be remembered */
  id: string;
  kind: DecisionKind;
  /** what is waiting — the line, the name, the kind of notice */
  title: string;
  /** where it is: "Ch 4 · The Iron Gate", "12 chapters", "Cast" */
  where: string;
  /** the decision itself, in one sentence */
  detail: string;
  /** when it arrived, for "oldest first"; 0 when the thing carries no time of its own */
  at: number;
  /** the chapter it sits in, when it sits in one — the group's "open the page" link starts there */
  chapterId?: number;
  /** lands on the row, not the top of the page */
  to: RouteLocationRaw;
}

export type DecisionTone = "red" | "amber" | "violet" | "sky" | "zinc";

export interface DecisionGroup {
  kind: DecisionKind;
  /** the heading, always plural: "Retakes waiting" */
  label: string;
  /** two words for the surfaces with one line, singular and plural — see `countOf` */
  one: string;
  many: string;
  /** what settling one of these means, one line under the heading */
  blurb: string;
  tone: DecisionTone;
  /** the page that can work through the whole group at once */
  all: RouteLocationRaw;
  allLabel: string;
  items: Decision[];
}

/** Heading, one-line explanation and colour for each kind. The page renders nothing of its own. */
const KINDS: Record<
  DecisionKind,
  { label: string; one: string; many: string; blurb: string; tone: DecisionTone }
> = {
  failed: {
    one: "failed run",
    many: "failed runs",
    label: "Runs that failed",
    blurb: "Retry them, or leave the chapter out of the audiobook.",
    tone: "red",
  },
  contents: {
    one: "notice to decide",
    many: "notices to decide",
    label: "Chapters the import wasn’t sure about",
    blurb: "Skip them or keep them in — one decision covers every chapter with the same note.",
    tone: "zinc",
  },
  unverified: {
    one: "unverified chunk",
    many: "unverified chunks",
    label: "Chunks that didn’t verify",
    blurb: "They were kept whole and will be read by the narrator unless they are re-split.",
    tone: "amber",
  },
  speaker: {
    one: "new speaker",
    many: "new speakers",
    label: "Speakers to review",
    blurb:
      "First seen in a re-script — merge each into an existing speaker, or keep it as its own.",
    tone: "amber",
  },
  merge: {
    one: "merge suggestion",
    many: "merge suggestions",
    label: "Merge suggestions",
    blurb:
      "Two names that look like one speaker. Merging moves the lines; keeping leaves them apart.",
    tone: "violet",
  },
  expression: {
    one: "expression",
    many: "expressions",
    label: "Expressions to place",
    blurb: "An edit moved the text under them — say where each one belongs, or drop it.",
    tone: "violet",
  },
  flagged: {
    one: "flagged clip",
    many: "flagged clips",
    label: "Flagged clips",
    blurb: "You marked these wrong while listening. Retake them, or clear the flag.",
    tone: "amber",
  },
  retake: {
    one: "retake",
    many: "retakes",
    label: "Retakes waiting",
    blurb:
      "A second take rendered beside the clip in the book. The book keeps the old one until you choose.",
    tone: "sky",
  },
};

/** Broken work first, then the pipeline in order: contents, scripting, cast, narration. */
const ORDER: DecisionKind[] = [
  "failed",
  "contents",
  "unverified",
  "speaker",
  "merge",
  "expression",
  "flagged",
  "retake",
];

const excerpt = (t: string, n = 64): string =>
  t.length > n ? t.slice(0, n).trimEnd() + "…" : t || "(empty line)";

/** Every decision on this book, grouped, empty groups dropped. */
export function reviewInbox(bookId: string): DecisionGroup[] {
  const castStore = useCastStore();
  const exportsStore = useExportsStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  const narrationStore = useNarrationStore();
  const scriptsStore = useScriptsStore();

  const chapters = libraryStore.chaptersOf(bookId);
  const where = (chId: number): string => {
    const c = libraryStore.chapter(bookId, chId);
    return c ? `Ch ${c.id} · ${c.title}` : `Ch ${chId}`;
  };
  const inNarration = (chId: number, segId: number, filter: string): RouteLocationRaw => ({
    path: `/book/${bookId}/narration`,
    query: { ch: String(chId), filter, seg: String(segId) },
  });
  const inScripting = (chId: number, segId: number): RouteLocationRaw => ({
    path: `/book/${bookId}/scripting`,
    query: { ch: String(chId), seg: String(segId) },
  });
  const items: Record<DecisionKind, Decision[]> = {
    failed: [],
    contents: [],
    unverified: [],
    speaker: [],
    merge: [],
    expression: [],
    flagged: [],
    retake: [],
  };

  // ---- runs that failed. Built from what is still broken rather than from the job history: a
  // chapter retried successfully is not a decision any more, however many failures it logged.
  const lastFailure = (kind: Job["kind"], chId: number): Job | undefined =>
    jobsStore.jobs
      .filter(
        (j) =>
          j.bookId === bookId && j.kind === kind && j.chapterId === chId && j.status === "failed",
      )
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      .at(-1);
  // the first error, not the last: a failed run signs off with "Job failed", and the line before it
  // is the one that says what actually went wrong
  const errorOf = (j: Job | undefined): string =>
    j?.activity?.find((e) => e.level === "error")?.message ?? "";
  for (const c of chapters)
    for (const stage of ["scripting", "narration"] as const) {
      if (c[stage] !== "failed") continue;
      const job = lastFailure(stage, c.id);
      items.failed.push({
        id: `failed:${stage}:${c.id}`,
        kind: "failed",
        title: stage === "scripting" ? "Scripting failed" : "Narration failed",
        where: where(c.id),
        detail:
          errorOf(job) ||
          (stage === "scripting"
            ? "The run kept nothing for this chapter."
            : "Some clips in this chapter came back as errors."),
        at: job?.finishedAt ?? 0,
        chapterId: c.id,
        to: {
          path: `/book/${bookId}/${stage}`,
          query: { ch: String(c.id), ...(stage === "narration" ? { filter: "failed" } : {}) },
        },
      });
    }
  for (const e of exportsStore.exportsOf(bookId).filter((x) => x.status === "failed"))
    items.failed.push({
      id: `failed:export:${e.id}`,
      kind: "failed",
      title: "The build failed",
      where: e.filename,
      detail:
        e.error || `v${e.version} stopped part-way. The version already on disk is untouched.`,
      at: jobsStore.jobs.find((j) => j.id === e.jobId)?.finishedAt ?? 0,
      to: { path: `/book/${bookId}/export` },
    });

  // ---- contents, grouped the way the review decides them: one verdict per kind of notice
  for (const g of libraryStore.noticeGroupsOf(bookId)) {
    if (!g.pending.length) continue;
    const shown = `Ch ${g.pending.slice(0, 4).join(", ")}`;
    items.contents.push({
      id: `contents:${g.kind}`,
      kind: "contents",
      title: g.label,
      where: shown + (g.pending.length > 4 ? ` +${g.pending.length - 4} more` : ""),
      detail:
        g.verdict === "skip"
          ? `${plural(g.pending.length, "chapter")} read as a notice rather than story.`
          : `${plural(g.pending.length, "chapter")} mix a note with the story, or carry a title that only looks like one.`,
      at: 0,
      to: {
        path: `/book/${bookId}/contents`,
        query: { filter: g.verdict === "skip" ? "suggested" : "review", kind: g.kind },
      },
    });
  }

  // ---- one pass over the script: unverified chunks, drifted expressions, flags, second takes
  for (const c of chapters)
    for (const s of scriptsStore.segmentsOf(bookId, c.id)) {
      if (s.fallback)
        items.unverified.push({
          id: `unverified:${c.id}:${s.id}`,
          kind: "unverified",
          title: excerpt(s.text),
          where: where(c.id),
          detail: s.fallbackRetrying
            ? "A re-split of this chunk is running."
            : `~${s.fallbackCount ?? 0} lines collapsed into one${s.fallbackMismatch ? ` — the text drifted at “${excerpt(s.fallbackMismatch, 32)}”` : ""}.`,
          at: 0,
          chapterId: c.id,
          to: inScripting(c.id, s.id),
        });
      if (s.flag)
        items.flagged.push({
          id: `flagged:${c.id}:${s.id}`,
          kind: "flagged",
          title: excerpt(s.text),
          where: where(c.id),
          detail: flagText(s.flag),
          at: s.flag.at,
          chapterId: c.id,
          to: inNarration(c.id, s.id, "flagged"),
        });
      if (s.candidate) {
        const rendering = ["queued", "generating"].includes(s.candidate.status);
        items.retake.push({
          id: `retake:${c.id}:${s.id}`,
          kind: "retake",
          title: excerpt(s.text),
          where: where(c.id),
          detail: rendering
            ? `Take ${s.candidate.n ?? 2} is still rendering.`
            : `Take ${s.candidate.n ?? 2} is waiting beside take ${s.audio.n ?? 1}.`,
          at: s.candidate.at ?? 0,
          chapterId: c.id,
          to: inNarration(c.id, s.id, "review"),
        });
      }
    }
  for (const issue of narrationStore.expressionIssues(
    bookId,
    chapters.map((c) => c.id),
  ))
    items.expression.push({
      id: `expression:${issue.chId}:${issue.segId}:${issue.annotationId}`,
      kind: "expression",
      title: issue.label,
      where: `${where(issue.chId)} · ${issue.speaker}`,
      detail: issue.reason,
      at: 0,
      chapterId: issue.chId,
      to: inScripting(issue.chId, issue.segId),
    });

  // ---- the cast: names a re-script brought in, and names that look like one speaker twice
  const stats = castStore.castStats(bookId);
  const lines = (name: string): string => plural(stats[name]?.lines ?? 0, "line");
  for (const c of castStore.charactersOf(bookId).filter((c) => c.isNew))
    items.speaker.push({
      id: `speaker:${c.name}`,
      kind: "speaker",
      title: c.name,
      where: stats[c.name]
        ? `${lines(c.name)} · first in Ch ${stats[c.name].first}`
        : "no lines yet",
      detail:
        "New in the cast since the last script. Merge it into an existing speaker, or keep it.",
      at: 0,
      to: { path: `/book/${bookId}/cast`, query: { speaker: c.name } },
    });
  for (const s of castStore.mergeSuggestions(bookId))
    items.merge.push({
      id: `merge:${s.from}`,
      kind: "merge",
      title: `${s.from} → ${s.into}`,
      where: `${lines(s.from)} would move`,
      detail: s.reason,
      at: 0,
      to: { path: `/book/${bookId}/cast`, query: { speaker: s.from } },
    });

  const allOf = (kind: DecisionKind, first: Decision): RouteLocationRaw => {
    const ch = first.chapterId == null ? undefined : String(first.chapterId);
    switch (kind) {
      case "failed":
        return { path: "/queue" };
      case "contents":
        return { path: `/book/${bookId}/contents` };
      case "unverified":
      case "expression":
        return { path: `/book/${bookId}/scripting`, query: { ch } };
      case "speaker":
        return { path: `/book/${bookId}/cast`, query: { only: "new" } };
      case "merge":
        return { path: `/book/${bookId}/cast` };
      default:
        return {
          path: `/book/${bookId}/narration`,
          query: { ch, filter: kind === "flagged" ? "flagged" : "review" },
        };
    }
  };
  const ALL_LABEL: Record<DecisionKind, string> = {
    failed: "Open the queue",
    contents: "Open the contents review",
    unverified: "Open the script",
    speaker: "Open the cast",
    merge: "Open the cast",
    expression: "Open the script",
    flagged: "Work through them in the ledger",
    retake: "Compare them in the ledger",
  };

  return ORDER.filter((k) => items[k].length).map((kind) => ({
    kind,
    ...KINDS[kind],
    all: allOf(kind, items[kind][0]),
    allLabel: ALL_LABEL[kind],
    items: items[kind],
  }));
}

/** One group as a phrase: "2 failed runs", "1 flagged clip". */
export const countOf = (g: DecisionGroup): string =>
  `${g.items.length} ${g.items.length === 1 ? g.one : g.many}`;

/** How many decisions are open, for the badges that only have room for a number. */
export const reviewCount = (bookId: string): number =>
  reviewInbox(bookId).reduce((n, g) => n + g.items.length, 0);

export function useReviewInbox(bookId: MaybeRefOrGetter<string>): ComputedRef<DecisionGroup[]> {
  return computed(() => reviewInbox(toValue(bookId)));
}
