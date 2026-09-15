// Scripting settings and run coordination. Execution stays in the mock simulator.
import { jobWaiting, logJob } from "@/lib/jobActivity";
import { keyring } from "@/lib/keyring";
import { profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import { key } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import type { ScriptSimContext } from "@/mock";
import { makeScriptSettings, simulateScriptRun } from "@/mock";
import type { ScriptEstimate, ScriptSettings } from "@/types";
import { defineStore } from "pinia";
import { useCastStore } from "./cast";
import { useEndpointsStore } from "./endpoints";
import { useJobsStore } from "./jobs";
import { useLibraryStore } from "./library";
import { useScriptsStore } from "./scripts";
import { useUiStore } from "./ui";
interface ScriptingState {
  scriptSettings: ScriptSettings;
}
export const useScriptingStore = defineStore("scripting", {
  state: (): ScriptingState => ({ scriptSettings: makeScriptSettings() }),
  getters: {
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
    runScripting(
      bookId: string,
      ids: number[],
      {
        keepEdits = false,
        retrySegmentId = null,
      }: {
        keepEdits?: boolean;
        retrySegmentId?: number | null;
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
      // re-scripting: remember what we had so the reader can show what changed (and optionally re-apply manual edits)
      for (const c of chs)
        if (retrySegmentId === null && scriptsStore.segments[key(bookId, c.id)]?.length) {
          scriptsStore._previous[key(bookId, c.id)] = clone(
            scriptsStore.segments[key(bookId, c.id)],
          );
          c.rescript = { keepEdits };
        }
      const jobs = chs.map((c) => {
        c.scripting = "queued";
        c.scriptingProgress = 0;
        const job = jobsStore.addJob(
          "scripting",
          bookId,
          `Script · ch ${c.id} · ${profile.name}`,
          c.id,
        );
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
        });
        jobWaiting(job, "Chapter has not been dispatched yet");
        return job;
      });
      jobsStore._sequential(jobs, (job, done) =>
        simulateScriptRun(this._scriptSim(), {
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
      this.runScripting(bookId, [chId], { keepEdits: true, retrySegmentId: segId });
    },
    _scriptSim(): ScriptSimContext {
      const castStore = useCastStore();
      const endpointsStore = useEndpointsStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const uiStore = useUiStore();

      return {
        // read through a call, not captured: concurrency is shared across books and both lists are
        // replaced wholesale elsewhere in the store
        jobs: () => jobsStore.jobs,
        profiles: () => endpointsStore.profiles,
        bookById: (id) => libraryStore.bookById(id),
        segmentsOf: (bookId, chId) => scriptsStore.segmentsOf(bookId, chId),
        setSegments: (bookId, chId, segs) => {
          scriptsStore.segments[key(bookId, chId)] = segs;
        },
        previousSegments: (bookId, chId) => scriptsStore._previous[key(bookId, chId)],
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
