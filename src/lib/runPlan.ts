// What a bulk run over several chapters would do, worked out without touching anything (pure).
// The picker's summary, the estimate, the button's label and the work the store queues all come
// from this one calculation.
import { isScripted } from "@/lib/scriptReview";
import { isSpoken } from "@/lib/siteText";
import type {
  Book,
  Chapter,
  ChapterState,
  NarrationStatus,
  NarrationScope,
  RunContribution,
  RunPlan,
  RunSkip,
  RunSkipReason,
  Segment,
  SelectionSummary,
} from "@/types";

export const RUN_SKIP_TEXT: Record<RunSkipReason, string> = {
  running: "already running or queued",
  unscripted: "not scripted yet",
  nothing: "nothing to do for this scope",
  pending: "every line this scope would run has a retake waiting",
  excluded: "skipped from the audiobook",
  unknown: "no longer in the book",
};

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

// ---------- what a selection contains ----------

/** The picker's dots, counts and shortcuts all use this. */
export function chapterState(c: Chapter, stage: "scripting" | "narration"): ChapterState {
  if (c.excluded) return "excluded";
  const status = stage === "scripting" ? c.scripting : c.narration;
  if (status === "running" || status === "queued") return "running";
  if (status === "failed") return "failed";
  if (stage === "narration" && status === "stale") return "stale";
  if (stage === "scripting" && isScripted(c)) return "done";
  if (stage === "narration" && status === "done") return "done";
  return "new";
}

const DONE_WORD: Record<"scripting" | "narration", string> = {
  scripting: "already scripted",
  narration: "already narrated",
};

/** “8 chapters selected: 3 new, 5 already scripted.” */
export function selectionSummary(
  chapters: Chapter[],
  stage: "scripting" | "narration",
): SelectionSummary {
  const counts: Record<ChapterState, number> = {
    new: 0,
    done: 0,
    failed: 0,
    stale: 0,
    running: 0,
    excluded: 0,
  };
  for (const c of chapters) counts[chapterState(c, stage)]++;
  const parts: string[] = [];
  if (counts.new) parts.push(`${counts.new} new`);
  if (counts.done) parts.push(`${counts.done} ${DONE_WORD[stage]}`);
  if (counts.stale) parts.push(`${counts.stale} stale`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.running) parts.push(`${counts.running} already running`);
  if (counts.excluded) parts.push(`${counts.excluded} skipped`);
  return {
    selected: chapters.length,
    counts,
    text: chapters.length
      ? `${plural(chapters.length, "chapter")} selected: ${parts.join(", ")}.`
      : "No chapters selected.",
  };
}

// ---------- which clips a narration scope actually runs ----------

/**
 * Asked of the line, not the chapter: a failed retake leaves the chapter reading as narrated. Every
 * retry path uses this one function so none retries a different set than the button counted.
 */
export const segmentFailed = (s: Segment): boolean =>
  s.audio.status === "failed" || s.candidate?.status === "failed";

/** Shared by the estimate, the plan and the run. */
function inScope(s: Segment, scope: NarrationScope): boolean {
  if (scope === "all") return true;
  if (scope === "failed") return segmentFailed(s);
  return ["none", "stale", "failed"].includes(s.audio.status);
}

export interface NarrationTargets {
  run: Segment[];
  /**
   * In-scope lines with a retake awaiting a verdict, listed either way: left out of `run` when
   * `keepPending`, else in it (the retake displaced).
   */
  pending: Segment[];
  /** already rendering; this run does not touch them */
  inFlight: number;
  /** lines the book does not read aloud (`isSpoken`) */
  skipped: number;
}

/**
 * The lines one chapter contributes to a run. Never queues a line twice, and leaves a pending
 * retake alone unless told to replace it: that comparison is the listener's, not a bulk run's.
 */
export function narrationTargets(
  segs: Segment[],
  scope: NarrationScope,
  keepPending: boolean,
  book: Pick<Book, "readNotes"> | undefined,
): NarrationTargets {
  const run: Segment[] = [];
  const pending: Segment[] = [];
  let inFlight = 0;
  let skipped = 0;
  for (const s of segs) {
    if (!isSpoken(s, book)) {
      skipped++;
      continue;
    }
    if (["queued", "generating"].includes(s.audio.status)) {
      inFlight++;
      continue;
    }
    if (s.candidate && ["queued", "generating"].includes(s.candidate.status)) {
      inFlight++;
      continue;
    }
    if (!inScope(s, scope)) continue;
    // a retake that rendered and is waiting to be judged; a failed one has nothing to compare
    if (s.candidate && s.candidate.duration > 0) {
      pending.push(s);
      if (keepPending) continue;
    }
    run.push(s);
  }
  return { run, pending, inFlight, skipped };
}

/**
 * A chapter's narration status, read off its spoken lines' clips; every run end writes this. Only
 * meaningful once nothing is in flight. A chapter with no spoken lines reads as done.
 */
export function chapterNarration(
  all: Segment[],
  book: Pick<Book, "readNotes"> | undefined,
): NarrationStatus {
  if (!all.length) return "none";
  const segs = all.filter((s) => isSpoken(s, book));
  if (!segs.length) return "done";
  if (segs.every((s) => s.audio.status === "none")) return "none";
  // part rendered is `failed`, not `stale`: `readinessOf` makes it the export's hard "Partly
  // narrated" blocker, where `stale` could be overridden and ship a file with holes
  if (segs.some((s) => !["done", "stale"].includes(s.audio.status))) return "failed";
  return segs.some((s) => s.audio.status === "stale") ? "stale" : "done";
}

// ---------- the plans ----------

const emptyPlan = (stage: "scripting" | "narration", scope: NarrationScope | null): RunPlan => ({
  stage,
  scope,
  chapters: [],
  skipped: [],
  fresh: 0,
  replace: 0,
  retry: 0,
  clips: 0,
  requests: 0,
  replacing: 0,
  pending: 0,
  skippedLines: 0,
});

function tally(plan: RunPlan): RunPlan {
  for (const c of plan.chapters) {
    if (c.contribution === "new") plan.fresh++;
    else if (c.contribution === "replace") plan.replace++;
    else plan.retry++;
    plan.clips += c.clips;
    plan.requests += c.requests;
    plan.replacing += c.replacing;
    plan.pending += c.pending;
  }
  return plan;
}

const skip = (c: Chapter, reason: RunSkipReason): RunSkip => ({
  id: c.id,
  title: c.title,
  reason,
});

/**
 * What re-scripting this selection would do. `hasScript` asks the chapter's status, not the lines
 * the browser holds: a chapter no page has loaded still has its script.
 */
export function scriptingPlan(
  chapters: Chapter[],
  requestsOf: (c: Chapter) => number,
  hasScript: (c: Chapter) => boolean,
): RunPlan {
  const plan = emptyPlan("scripting", null);
  for (const c of chapters) {
    if (c.excluded) {
      plan.skipped.push(skip(c, "excluded"));
      continue;
    }
    if (["running", "queued"].includes(c.scripting)) {
      plan.skipped.push(skip(c, "running"));
      continue;
    }
    const contribution: RunContribution = hasScript(c)
      ? "replace"
      : c.scripting === "failed"
        ? "retry"
        : "new";
    plan.chapters.push({
      id: c.id,
      title: c.title,
      contribution,
      clips: 0,
      requests: requestsOf(c),
      // a re-script replaces exactly one thing: the chapter's script
      replacing: contribution === "replace" ? 1 : 0,
      pending: 0,
    });
  }
  return tally(plan);
}

export interface NarrationPlanOptions {
  segmentsOf: (chId: number) => Segment[];
  /** after expressions and the endpoint's limit */
  requestsOf: (s: Segment) => number;
  /** leave lines whose retake is waiting for a verdict out of the run */
  keepPending: boolean;
  /** `readNotes` decides which lines are read aloud (`isSpoken`) */
  book: Pick<Book, "readNotes"> | undefined;
}

export function narrationPlan(
  chapters: Chapter[],
  scope: NarrationScope,
  opts: NarrationPlanOptions,
): RunPlan {
  const plan = emptyPlan("narration", scope);
  for (const c of chapters) {
    if (c.excluded) {
      plan.skipped.push(skip(c, "excluded"));
      continue;
    }
    if (!isScripted(c)) {
      plan.skipped.push(skip(c, "unscripted"));
      continue;
    }
    if (["running", "queued"].includes(c.narration)) {
      plan.skipped.push(skip(c, "running"));
      continue;
    }
    const segs = opts.segmentsOf(c.id);
    const { run, pending, skipped } = narrationTargets(segs, scope, opts.keepPending, opts.book);
    plan.skippedLines += skipped;
    // pending retakes still count towards the total; `tally` adds the surviving chapters' own
    if (!run.length) {
      plan.pending += pending.length;
      plan.skipped.push(skip(c, pending.length ? "pending" : "nothing"));
      continue;
    }
    const replacing = run.filter((s) => s.audio.duration > 0).length;
    const retrying = run.filter(segmentFailed).length;
    plan.chapters.push({
      id: c.id,
      title: c.title,
      contribution: replacing ? "replace" : retrying ? "retry" : "new",
      clips: run.length,
      requests: run.reduce((n, s) => n + opts.requestsOf(s), 0),
      replacing,
      pending: pending.length,
    });
  }
  return tally(plan);
}

// ---------- how a plan reads ----------

const VERBS: Record<"scripting" | "narration", Record<RunContribution, string>> = {
  scripting: { new: "Script", replace: "Re-script", retry: "Retry" },
  narration: { new: "Narrate", replace: "Re-narrate", retry: "Retry" },
};

/** The run button's label: “Script 3 · re-script 5”. */
export function runActionLabel(plan: RunPlan): string {
  const verbs = VERBS[plan.stage];
  const parts: string[] = [];
  if (plan.fresh) parts.push(`${verbs.new} ${plan.fresh}`);
  if (plan.replace) parts.push(`${verbs.replace} ${plan.replace}`);
  if (plan.retry) parts.push(`${verbs.retry} ${plan.retry}`);
  if (!parts.length) return plan.stage === "scripting" ? "Run scripting" : "Narrate";
  const label = parts.map((p, i) => (i === 0 ? p : p[0].toLowerCase() + p.slice(1))).join(" · ");
  return parts.length === 1
    ? `${label} ${plan.chapters.length === 1 ? "chapter" : "chapters"}`
    : label;
}

export function runSummary(plan: RunPlan): string[] {
  const verbs = VERBS[plan.stage];
  const out: string[] = [];
  if (plan.fresh) out.push(`${plan.fresh} to ${verbs.new.toLowerCase()}`);
  if (plan.replace) out.push(`${plan.replace} to ${verbs.replace.toLowerCase()}`);
  if (plan.retry) out.push(`${plan.retry} to retry`);
  if (plan.stage === "narration") {
    out.push(plural(plan.clips, "clip"));
    out.push(plural(plan.requests, "request"));
  } else out.push(plural(plan.requests, "request"));
  return out;
}

/** The skipped chapters, grouped by reason. */
export function skipNotes(plan: RunPlan): { reason: RunSkipReason; text: string; ids: number[] }[] {
  const order: RunSkipReason[] = [
    "running",
    "unscripted",
    "nothing",
    "pending",
    "excluded",
    "unknown",
  ];
  const by = new Map<RunSkipReason, number[]>();
  for (const s of plan.skipped) by.set(s.reason, [...(by.get(s.reason) ?? []), s.id]);
  return order
    .filter((r) => by.has(r))
    .map((reason) => ({ reason, text: RUN_SKIP_TEXT[reason], ids: by.get(reason)! }));
}

/** “2 chapters left out: 1 already running, 1 skipped from the audiobook.” */
export function skipSummary(plan: RunPlan): string {
  if (!plan.skipped.length) return "";
  const notes = skipNotes(plan)
    .map((n) => `${n.ids.length} ${n.text}`)
    .join(", ");
  return `${plural(plan.skipped.length, "chapter")} left out: ${notes}.`;
}

export const SCOPE_LABEL: Record<NarrationScope, string> = {
  fill: "Missing & changed",
  failed: "Failed only",
  all: "Everything",
};

export const SCOPE_HELP: Record<NarrationScope, string> = {
  fill: "Renders lines with no usable clip — never narrated, or the request failed — and lines whose clip no longer matches the script.",
  failed: "Renders only the lines whose last request failed. Finished clips are not touched.",
  all: "Renders every line in the selected chapters, replacing clips that are perfectly current.",
};
