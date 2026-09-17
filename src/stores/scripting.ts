// Scripting settings and run coordination. Execution stays in the mock simulator.
import { jobWaiting, logJob } from "@/lib/jobActivity";
import { keyring } from "@/lib/keyring";
import { runActionLabel, scriptingPlan, skipNotes, skipSummary } from "@/lib/runPlan";
import { profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import { key } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import type { ScriptSimContext } from "@/mock";
import { makeScriptSettings, simulateScriptRun } from "@/mock";
import type { Profile, RunPlan, ScriptEstimate, ScriptSettings } from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
interface ScriptingState {
  scriptSettings: ScriptSettings;
}
export const useScriptingStore = defineStore("scripting", {
  state: (): ScriptingState => ({ scriptSettings: makeScriptSettings() }),
  getters: {
    /**
     * What running the current selection would do: which chapters are new work, which replace a
     * script that is already finished, and which are left out and why. The picker's summary, the
     * button's label and the work `runScripting` queues all read this.
     */
    scriptPlan(): (bookId: string, ids: number[]) => RunPlan {
      const endpointsStore = useEndpointsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (bookId, ids) => {
        const p = endpointsStore.profiles.find((p) => p.id === this.scriptSettings.profile);
        const usable = p && !profileErrors(p).length;
        return scriptingPlan(
          libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id)),
          (c) => (usable ? scriptParts(scriptsStore.rawText(bookId, c.id), p!).length : 0),
        );
      };
    },
    scriptEstimate(): (
      bookId: string,
      ids: number[],
      retrySegmentId?: number | null,
    ) => ScriptEstimate {
      const endpointsStore = useEndpointsStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      return (
        bookId: string,
        ids: number[],
        retrySegmentId: number | null = null,
      ): ScriptEstimate => {
        const chs = libraryStore
          .chaptersOf(bookId)
          .filter(
            (c) =>
              ids.includes(c.id) && !c.excluded && !["running", "queued"].includes(c.scripting),
          );
        const p = endpointsStore.profiles.find((p) => p.id === this.scriptSettings.profile);
        const blockers = p ? profileErrors(p) : ["Select a scripting endpoint."];
        if (p && !p.enabled) blockers.push("This endpoint is paused. Enable it or select another.");
        if (p?.needsKey && !keyring.has("profile:" + p.id))
          blockers.push("Add an API key in endpoint settings.");
        if (libraryStore.bookById(bookId)?.budget?.paused)
          blockers.push("This book is paused. Resume it from the overview.");
        const texts = chs.map((c) =>
          retrySegmentId === null
            ? scriptsStore.rawText(bookId, c.id)
            : (scriptsStore.segmentsOf(bookId, c.id).find((x) => x.id === retrySegmentId)?.text ??
              ""),
        );
        const parts =
          p && !profileErrors(p).length ? texts.map((text) => scriptParts(text, p)) : [];
        const tokens = parts.flat().map((text) => tokenEstimate(text, p!));
        const inputCost = tokens.reduce((n, t) => n + t.inputCost, 0);
        const outputCost = tokens.reduce((n, t) => n + t.outputCost, 0);
        const scriptingRemaining =
          (libraryStore.bookById(bookId)?.scriptBudget ?? Infinity) -
          jobsStore.scriptSpent(bookId) -
          jobsStore.scriptReserved(bookId);
        const overallRemaining =
          (libraryStore.bookById(bookId)?.budget?.cap ?? Infinity) -
          jobsStore.spent(bookId) -
          jobsStore.scriptReserved(bookId);
        const remaining = Math.min(scriptingRemaining, overallRemaining);
        if (inputCost + outputCost > remaining)
          blockers.push("Estimated cost exceeds the remaining book budget.");
        if (tokens.some((t) => t.outputTokens > p!.maxOutputTokens))
          blockers.push(
            "A chunk may exceed the output token limit. Reduce max characters or increase max output tokens.",
          );
        if (tokens.some((t) => t.reserve > remaining))
          blockers.push("Budget cannot reserve one request at its output token limit.");
        return {
          chapters: chs.length,
          chars: texts.reduce((n, t) => n + t.length, 0),
          chunks: tokens.length,
          inputTokens: tokens.reduce((n, t) => n + t.inputTokens, 0),
          outputTokens: tokens.reduce((n, t) => n + t.outputTokens, 0),
          inputCost,
          outputCost,
          cost: inputCost + outputCost,
          profile: p,
          blockers,
          seconds: parts.reduce(
            (n, xs) => n + Math.ceil(xs.length / p!.concurrency) * p!.secPerChunk,
            0,
          ),
        };
      };
    },
  },
  actions: {
    /**
     * Script (or re-script) the given chapters.
     *
     * Manual corrections are preserved by default: a bulk re-script over a book somebody has been
     * correcting by hand must not be the one operation in the app that throws that work away.
     * Nothing about the chapter changes until the run has a script to write — a run that fails, is
     * cancelled or hits the budget leaves the script, the cast and the audio exactly as it found
     * them, and the chapter goes back to the status it had rather than reading as unscripted.
     */
    runScripting(
      bookId: string,
      ids: number[],
      {
        keepEdits = true,
        retrySegmentId = null,
        quiet = false,
      }: {
        keepEdits?: boolean;
        retrySegmentId?: number | null;
        /** a single-chapter run started from the reader says its own piece; no run summary */
        quiet?: boolean;
      } = {},
    ): void {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "script")) return;
      const estimate = this.scriptEstimate(bookId, ids, retrySegmentId);
      if (estimate.blockers.length) {
        uiStore.toast("Scripting needs attention", {
          kind: "warn",
          description: estimate.blockers[0],
        });
        return;
      }
      if (!estimate.chapters) return;
      const plan = this.scriptPlan(bookId, ids);
      const profile = clone(estimate.profile!);
      const textOf = (chId: number) =>
        retrySegmentId === null
          ? scriptsStore.rawText(bookId, chId)
          : (scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === retrySegmentId)?.text ??
            "");
      const chs = libraryStore.chapters[bookId].filter(
        (c) =>
          ids.includes(c.id) &&
          !c.excluded &&
          c.scripting !== "running" &&
          c.scripting !== "queued",
      );
      const runId = jobsStore._nextRunId();
      const op = retrySegmentId === null ? runActionLabel(plan) : "Re-split one chunk";
      const jobs = chs.map((c, i) => {
        const replacing =
          retrySegmentId === null && !!scriptsStore.segments[key(bookId, c.id)]?.length;
        // re-scripting: remember what we had so the reader can show what changed (and re-apply
        // manual corrections), and what status to go back to if this attempt produces nothing
        const was = c.scripting;
        if (replacing)
          scriptsStore._previous[key(bookId, c.id)] = clone(
            scriptsStore.segments[key(bookId, c.id)],
          );
        c.scripting = "queued";
        c.scriptingProgress = 0;
        const job = jobsStore.addJob(
          "scripting",
          bookId,
          `${replacing ? "Re-script" : "Script"} · ch ${c.id} · ${profile.name}`,
          c.id,
        );
        job.bulk = {
          id: runId,
          op,
          index: i + 1,
          total: chs.length,
          scope: keepEdits ? "preserving manual corrections" : "manual corrections discarded",
        };
        // the run that is allowed to write this chapter's script: a later run, a restore or a
        // cancellation take the token away, so a callback from this one can no longer land
        c.rescript = { keepEdits, was, token: job.id };
        job.scriptRun = {
          profile: clone(profile),
          requests: scriptParts(textOf(c.id), profile).length,
          completed: 0,
          active: 0,
          reserved: 0,
          cost: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        logJob(job, "Scripting plan prepared", "info", {
          endpoint: profile.name,
          model: profile.model,
          requests: job.scriptRun.requests,
          characters: textOf(c.id).length,
          concurrency: profile.concurrency,
          operation: replacing ? "replace the existing script" : "script for the first time",
          manualCorrections: keepEdits ? "re-applied where the line still matches" : "discarded",
          ...(replacing
            ? {
                previousScript:
                  "kept in the chapter's history, and until this run writes a new one",
              }
            : {}),
        });
        jobWaiting(job, "Chapter has not been dispatched yet");
        return job;
      });
      if (!quiet && jobs.length) {
        const skips = skipNotes(plan);
        uiStore.toast(`${op} · ${jobs.length === 1 ? "1 chapter" : jobs.length + " chapters"}`, {
          kind: "info",
          description:
            `${profile.name} · ${profile.model} · ${plan.requests} request${plan.requests === 1 ? "" : "s"} · ~$${estimate.cost.toFixed(2)}. ` +
            (plan.replace
              ? `${plan.replace} finished script${plan.replace === 1 ? "" : "s"} will be replaced; each is preserved in its chapter's history first. `
              : "") +
            (keepEdits ? "Manual corrections are re-applied where the line still matches. " : "") +
            (skips.length ? skipSummary(plan) : ""),
          timeout: 10000,
        });
      }
      jobsStore._sequential(jobs, (job, done) =>
        simulateScriptRun(this._scriptSim(profile), {
          bookId,
          c: libraryStore.chapter(bookId, job.chapterId!)!,
          job,
          profile,
          textOf,
          retrySegmentId,
          // the run's remaining queue: `_sequential` shifts it, so this is what is still pending
          jobs,
          done,
        }),
      );
    },
    // Re-run the LLM on just the chunk that fell back. Simulated: replaced by properly split segments.
    retryChunk(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const seg = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!seg?.fallback) return;
      this.runScripting(bookId, [chId], {
        keepEdits: true,
        retrySegmentId: segId,
        quiet: true,
      });
    },
    _scriptSim(profile: Profile): ScriptSimContext {
      const castStore = useCastStore();
      const demoStore = useDemoStore();
      const endpointsStore = useEndpointsStore();
      const historyStore = useHistoryStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      // the generation of the demo world this run belongs to, taken as it starts
      const epoch = demoStore._epoch;
      return {
        stale: () => demoStore.isStale(epoch),
        paused: (id) => !!libraryStore.bookById(id)?.budget?.paused,
        // read through a call, not captured: concurrency is shared across books and both lists are
        // replaced wholesale elsewhere in the store
        jobs: () => jobsStore.jobs,
        profiles: () => endpointsStore.profiles,
        bookById: (id) => libraryStore.bookById(id),
        segmentsOf: (bookId, chId) => scriptsStore.segmentsOf(bookId, chId),
        // The run's one way of writing a script, so this is where the script it replaces is kept.
        // A run that failed, was cancelled or ran out of budget never gets here, so a good script is
        // never pushed into the history by an attempt that produced nothing.
        setSegments: (bookId, chId, segs) => {
          historyStore.noteScripted(bookId, chId, profile, segs);
          scriptsStore.segments[key(bookId, chId)] = segs;
        },
        previousSegments: (bookId, chId) => scriptsStore._previous[key(bookId, chId)],
        noteCorrections: (bookId, chId, report) =>
          scriptsStore._noteCorrections(bookId, chId, report),
        absorbCast: (bookId, chId) => castStore._absorbCast(bookId, chId),
        scriptSpent: (bookId) => jobsStore.scriptSpent(bookId),
        scriptReserved: (bookId) => jobsStore.scriptReserved(bookId),
        spent: (bookId) => jobsStore.spent(bookId),
        recordUsage: (u) => {
          jobsStore.scriptUsage.push(u);
        },
        telemetryFor: (id) => jobsStore.scriptingTelemetry(id),
        cancelJob: (id) => jobsStore.cancelJob(id),
        finishJob: (job, status) => jobsStore._finish(job, status),
        toast: (msg, opts) => uiStore.toast(msg, opts),
      };
    },
  },
});
