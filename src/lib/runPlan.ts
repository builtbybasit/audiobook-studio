// What a bulk run over several chapters would actually do, worked out without touching anything.
//
// Completed chapters have always been allowed into a run; what was missing was a straight answer to
// "what is in this selection, and what will pressing the button do to it". Both stages ask that
// question here, so the picker's summary, the estimate, the button's own label and the work the
// store queues are one calculation rather than four that agree by luck.
//
// Nothing here mutates and nothing here reaches a store: the chapters and segments arrive as
// arguments, and the costs a stage knows how to price arrive as callbacks.
import { isScripted } from "@/lib/scriptReview";
import type {
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

/** Why a chapter is not in the run, as the panels say it. */
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

/** How one chapter reads at a stage. The picker's dots, counts and shortcuts all use this. */
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

/**
 * What the current selection contains, as one sentence:
 * “8 chapters selected: 3 new, 5 already scripted.”
 */
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

/** One definition of "is this line in scope", shared by the estimate, the plan and the run. */
function inScope(s: Segment, scope: NarrationScope): boolean {
  if (scope === "all") return true;
  if (scope === "failed") return s.audio.status === "failed" || s.candidate?.status === "failed";
  return ["none", "stale", "failed"].includes(s.audio.status);
}

export interface NarrationTargets {
  /** the lines this run will render */
  run: Segment[];
  /**
   * Lines this scope would render that have a retake waiting for a verdict. They are the ones the
   * "keep retakes" choice is actually about, so they are reported whichever way it is set: left out
   * of `run` when `keepPending`, and in it — the retake displaced — when it is off. A line the
   * scope would not have touched is not listed here, because nothing was decided about it.
   */
  pending: Segment[];
  /** lines whose clip or retake is already rendering — this run does not touch them */
  inFlight: number;
}

/**
 * The lines one chapter contributes to a run. A line already rendering is never queued twice, and a
 * retake waiting for a verdict is left where it is unless the run was explicitly told to replace it
 * — a pending comparison is the listener's, not a bulk run's to delete.
 */
export function narrationTargets(
  segs: Segment[],
  scope: NarrationScope,
  keepPending: boolean,
): NarrationTargets {
  const run: Segment[] = [];
  const pending: Segment[] = [];
  let inFlight = 0;
  for (const s of segs) {
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
  return { run, pending, inFlight };
}

/**
 * What a chapter's narration status is, read off its clips. One definition, so a run that
 * finished, a run that was cancelled and a run that had nothing to do all leave the chapter saying
 * the same thing about the same clips. Only meaningful once nothing is in flight.
 */
export function chapterNarration(segs: Segment[]): NarrationStatus {
  if (!segs.length || segs.every((s) => s.audio.status === "none")) return "none";
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
 * What re-scripting this selection would do. A chapter that already has a script is a replacement,
 * one that failed is a retry, and one that has never been scripted is new work.
 */
export function scriptingPlan(chapters: Chapter[], requestsOf: (c: Chapter) => number): RunPlan {
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
    const contribution: RunContribution =
      c.scripting === "failed" ? "retry" : isScripted(c) ? "replace" : "new";
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
  /** how many endpoint requests one line becomes, after expressions and the endpoint's limit */
  requestsOf: (s: Segment) => number;
  /** leave lines whose retake is waiting for a verdict out of the run */
  keepPending: boolean;
}

/** What narrating this selection at this scope would do, line by line. */
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
    const { run, pending } = narrationTargets(segs, scope, opts.keepPending);
    // nothing to run and something waiting to be judged: the retakes are the reason, so say so
    if (!run.length) {
      plan.skipped.push(skip(c, pending.length ? "pending" : "nothing"));
      continue;
    }
    const replacing = run.filter((s) => s.audio.duration > 0).length;
    const retrying = run.filter(
      (s) => s.audio.status === "failed" || s.candidate?.status === "failed",
    ).length;
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

/**
 * What the run button says, so the label is the operation rather than a generic "Run": a selection
 * that does both names both — “Script 3 · re-script 5”.
 */
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

/**
 * The run in one line, said in the terms the user chose it in: how many chapters do which kind of
 * work, how much of it actually runs, and what is being kept while it does.
 */
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

/** The skipped chapters, grouped by reason, in the order the reasons are worth reading. */
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

/** “2 chapters left out: 1 already running, 1 skipped from the audiobook.” Empty when none are. */
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
