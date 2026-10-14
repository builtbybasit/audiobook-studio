// Every decision one book is waiting on, in one list, each with a link that lands on its row.
// Read-only over the stores, like `bookFacts`. A site-text suggestion is the one decision the page
// can also settle in place (`siteCheck`), through the reader's store actions and Undo.
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";

import { defineStore } from "pinia";
import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import type { RouteLocationRaw } from "vue-router";
import { flagText } from "@/lib/scriptReview";
import type { Job, Segment } from "@/types";
import { plural } from "@/lib/contents";
import { isSpoken, UNREAD_SHARE_WARNING, unreadShare } from "@/lib/siteText";

/** The stage a decision belongs to, which is also the page it is settled on. */
export type DecisionKind =
  | "failed"
  | "contents"
  | "unverified"
  | "sitetext"
  | "speaker"
  | "merge"
  | "expression"
  | "flagged"
  | "retake";

export interface Decision {
  /** stable across a re-read, so the list can key on it */
  id: string;
  kind: DecisionKind;
  title: string;
  /** "Ch 4 · The Iron Gate", "12 chapters", "Cast" */
  where: string;
  detail: string;
  /** for "oldest first"; 0 when the thing carries no time of its own */
  at: number;
  /** the group's "open the page" link starts at this chapter */
  chapterId?: number;
  to: RouteLocationRaw;
  /** set when the row can be accepted or dismissed from the list */
  siteCheck?: { chapterId: number; segmentId: number; suggest: "watermark" | "narration" };
}

export type DecisionTone = "red" | "amber" | "violet" | "sky" | "zinc";

export interface DecisionGroup {
  kind: DecisionKind;
  /** always plural: "Retakes waiting" */
  label: string;
  /** singular and plural, for one-line surfaces — see `countOf` */
  one: string;
  many: string;
  blurb: string;
  tone: DecisionTone;
  all: RouteLocationRaw;
  allLabel: string;
  items: Decision[];
}

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
  sitetext: {
    one: "site-text check",
    many: "site-text checks",
    label: "Site text to check",
    blurb:
      "Lines the detector thinks are typed wrong, and chapters with an unusual share marked as site text. A line marked by mistake is silently missing from the audio.",
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
    blurb:
      "Marked wrong while listening — by you, or by a check by ear that heard something else. Retake them, or clear the flag.",
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
  "sitetext",
  "speaker",
  "merge",
  "expression",
  "flagged",
  "retake",
];

const excerpt = (t: string, n = 64): string =>
  t.length > n ? t.slice(0, n).trimEnd() + "…" : t || "(empty line)";

/** One inbox per book, recomputed once per change to the stores it reads, however many show it. */
const useInboxes = defineStore("reviewInbox", () => {
  // One computed per chapter, so a change to one script rescans only that chapter. Not returned, so
  // Pinia does not wrap each call as an action.
  // ponytail: one entry per chapter ever scanned, never evicted; key by book if memory matters
  const chapters = new Map<string, ComputedRef<ChapterScan>>();
  function scanOf(bookId: string, chId: number): ChapterScan {
    const k = `${bookId}:${chId}`;
    let scanned = chapters.get(k);
    if (!scanned) chapters.set(k, (scanned = computed(() => scan(bookId, chId))));
    return scanned.value;
  }
  const books = new Map<string, ComputedRef<DecisionGroup[]>>();
  function of(bookId: string): DecisionGroup[] {
    let inbox = books.get(bookId);
    if (!inbox) books.set(bookId, (inbox = computed(() => gather(bookId, scanOf))));
    return inbox.value;
  }
  return { of };
});

interface ChapterScan {
  /** counted as the scripting job counts it */
  unread: ReturnType<typeof unreadShare>;
  siteChecks: Segment[];
  fallbacks: Segment[];
  flags: Segment[];
  candidates: Segment[];
  expressions: boolean;
}

function scan(bookId: string, chId: number): ChapterScan {
  const segs = useScriptsStore().segmentsOf(bookId, chId);
  const book = useLibraryStore().bookById(bookId);
  return {
    // counting words is the costly part, so only where something is unread
    unread: segs.some((s) => !isSpoken(s, book))
      ? unreadShare(segs, book)
      : { words: 0, unread: 0, lines: 0, share: 0 },
    siteChecks: segs.filter((s) => s.siteCheck),
    fallbacks: segs.filter((s) => s.fallback),
    flags: segs.filter((s) => s.flag),
    candidates: segs.filter((s) => s.candidate),
    expressions: segs.some((s) => s.expressions?.length),
  };
}

export const reviewInbox = (bookId: string): DecisionGroup[] => useInboxes().of(bookId);

function gather(
  bookId: string,
  scanOf: (bookId: string, chId: number) => ChapterScan,
): DecisionGroup[] {
  const castStore = useCastStore();
  const exportsStore = useExportsStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  const narrationStore = useNarrationStore();

  const chapters = libraryStore.chaptersOf(bookId);
  const scans = chapters.map((c) => scanOf(bookId, c.id));
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const numbers = libraryStore.chapterNumbers[bookId];
  const where = (chId: number): string => {
    const c = byId.get(chId);
    if (!c) return "A chapter not in the book";
    const n = numbers?.get(chId);
    return `${n ? `Ch ${n}` : "Skipped"} · ${c.title}`;
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
    sitetext: [],
    speaker: [],
    merge: [],
    expression: [],
    flagged: [],
    retake: [],
  };

  // Runs that failed: built from what is still broken, not the job history, so a chapter retried
  // successfully drops out. Latest failure per stage per chapter.
  const failures = new Map<string, Job>();
  for (const j of jobsStore.jobs) {
    if (j.bookId !== bookId || j.status !== "failed") continue;
    const k = `${j.kind}:${j.chapterId}`;
    const was = failures.get(k);
    if (!was || (j.finishedAt ?? 0) >= (was.finishedAt ?? 0)) failures.set(k, j);
  }
  const lastFailure = (kind: Job["kind"], chId: number): Job | undefined =>
    failures.get(`${kind}:${chId}`);
  // the first error, not the last: the last is always "Job failed"
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

  for (const g of libraryStore.noticeGroupsOf(bookId)) {
    if (!g.pending.length) continue;
    // a pending chapter is still kept, so each has its number
    const shown = `Ch ${g.pending
      .slice(0, 4)
      .map((id) => numbers?.get(id))
      .join(", ")}`;
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

  // Site text. Marking too much is the dangerous direction (marked story is silently missing from
  // the audio), so a chapter with an unusual unread share is listed before line-by-line doubts.
  chapters.forEach((c, i) => {
    const scanned = scans[i];
    const { words: all, unread, lines, share } = scanned.unread;
    if (share > UNREAD_SHARE_WARNING)
      items.sitetext.push({
        id: `sitetext:share:${c.id}`,
        kind: "sitetext",
        title: `${Math.round(share * 100)}% of the chapter is marked as not read`,
        where: where(c.id),
        detail: `${plural(lines, "line")} of site text or notes — ${plural(unread, "word")} of ${all.toLocaleString()} left out of the audio. Check none of it is story.`,
        at: 0,
        chapterId: c.id,
        to: { path: `/book/${bookId}/scripting`, query: { ch: String(c.id), lines: "site" } },
      });
    for (const s of scanned.siteChecks)
      if (s.siteCheck)
        items.sitetext.push({
          id: `sitetext:${c.id}:${s.id}`,
          kind: "sitetext",
          title: excerpt(s.text),
          where: where(c.id),
          detail:
            s.siteCheck.suggest === "watermark"
              ? `Read as story, looks like site text — ${s.siteCheck.why}.`
              : `Marked as site text, reads like story — ${s.siteCheck.why}.`,
          at: 0,
          chapterId: c.id,
          to: inScripting(c.id, s.id),
          siteCheck: { chapterId: c.id, segmentId: s.id, suggest: s.siteCheck.suggest },
        });
  });

  chapters.forEach((c, i) => {
    const scanned = scans[i];
    for (const s of scanned.fallbacks)
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
    for (const s of scanned.flags)
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
    for (const s of scanned.candidates)
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
  });
  // only chapters with an expression can have one out of place; checking reads text through the
  // dictionary, which is costly
  for (const issue of narrationStore.expressionIssues(
    bookId,
    chapters.filter((_, i) => scans[i].expressions).map((c) => c.id),
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

  const stats = castStore.castStats(bookId);
  const lines = (name: string): string => plural(stats[name]?.lines ?? 0, "line");
  const firstIn = (name: string): string => {
    const n = numbers?.get(stats[name].first);
    return n ? `first in Ch ${n}` : "first in a skipped chapter";
  };
  for (const c of castStore.charactersOf(bookId).filter((c) => c.isNew))
    items.speaker.push({
      id: `speaker:${c.name}`,
      kind: "speaker",
      title: c.name,
      where: stats[c.name] ? `${lines(c.name)} · ${firstIn(c.name)}` : "no lines yet",
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
      case "sitetext":
        return { path: `/book/${bookId}/scripting`, query: { ch, lines: "site" } };
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
    sitetext: "Open the script’s site text",
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

export const countOf = (g: DecisionGroup): string =>
  `${g.items.length} ${g.items.length === 1 ? g.one : g.many}`;

export const reviewCount = (bookId: string): number =>
  reviewInbox(bookId).reduce((n, g) => n + g.items.length, 0);

export function useReviewInbox(bookId: MaybeRefOrGetter<string>): ComputedRef<DecisionGroup[]> {
  return computed(() => reviewInbox(toValue(bookId)));
}
