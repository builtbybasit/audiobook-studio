// Scripting settings and run coordination. The runs themselves are the server's.
import { keyInPlace } from "@/services/endpointSettings";
import { plural } from "@/lib/contents";
import { scriptingPlan } from "@/lib/runPlan";
import { ApiError } from "@/services/http";
import { jobsService } from "@/services/jobs";
import { baseRates, ensurePricing, estimateRates } from "@/lib/pricing";
import { resolvePrompt } from "@/lib/prompt";
import { makeScriptSettings, profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import { recentCacheRate } from "@/lib/scriptActivity";
import { scriptActivityNow } from "@/queries/scriptActivity";
import type { RunPlan, ScriptEstimate, ScriptSettings } from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
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
     * button's label and the estimate all read this.
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
          (c) => scriptsStore.segmentsOf(bookId, c.id).length > 0,
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
        // the plan decides which chapters a run would touch; the estimate prices exactly those
        const chs = this.scriptPlan(bookId, ids).chapters.map((row) =>
          libraryStore.chapter(bookId, row.id)!,
        );
        const p = endpointsStore.profiles.find((p) => p.id === this.scriptSettings.profile);
        const blockers = p ? profileErrors(p) : ["Select a scripting endpoint."];
        if (p && !p.enabled) blockers.push("This endpoint is paused. Enable it or select another.");
        if (p?.needsKey && !keyInPlace(p)) blockers.push("Add an API key in endpoint settings.");
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
        // one instant for the whole estimate, so the figures on screen agree with each other
        const at = Date.now();
        // priced with the prompt the run would send: the book's, the endpoint's or the library's
        const prompt = p
          ? resolvePrompt({
              library: endpointsStore.prompt,
              profile: p.prompt,
              book: libraryStore.bookById(bookId)?.prompt,
            })
          : undefined;
        const tokens = parts.flat().map((text) => tokenEstimate(text, p!, at, prompt));
        const inputCost = tokens.reduce((n, t) => n + t.inputCost, 0);
        const outputCost = tokens.reduce((n, t) => n + t.outputCost, 0);
        const rates = p
          ? estimateRates(
              baseRates(p),
              ensurePricing(p),
              {
                inputTokens: tokens.reduce((n, t) => n + t.inputTokens, 0),
                outputTokens: tokens.reduce((n, t) => n + t.outputTokens, 0),
              },
              at,
              // what the ledger says this profile's recent requests had cached, when a page has
              // read it; the conservative figure never depends on it
              recentCacheRate(scriptActivityNow(p.id)),
            )
          : null;
        const scriptingRemaining =
          (libraryStore.bookById(bookId)?.scriptBudget ?? Infinity) -
          jobsStore.scriptSpent(bookId) -
          jobsStore.scriptReserved(bookId);
        const overallRemaining =
          (libraryStore.bookById(bookId)?.budget?.cap ?? Infinity) -
          jobsStore.spent(bookId) -
          jobsStore.scriptReserved(bookId);
        const remaining = Math.min(scriptingRemaining, overallRemaining);
        // A budget is checked against the price with **no** discount and **no** cache saving. A
        // promotion can expire and an off-peak window can close while a run is still going, so a
        // cap that only holds while a discount lasts is not a cap. See `estimateRates`.
        const worstCase = rates ? Math.max(rates.withoutPromotions, rates.cost) : 0;
        if (worstCase > remaining)
          blockers.push(
            rates && rates.withoutPromotions > rates.cost + 1e-9
              ? "Without the discounts in force, this run does not fit the remaining book budget — and a discount can expire mid-run."
              : "Estimated cost exceeds the remaining book budget.",
          );
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
          rates,
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
     * Script (or re-script) the given chapters, as one run.
     *
     * The run is the server's: it is queued there, the queue is polled and what comes back is what
     * the chapter holds. The budget is the server's to enforce: it prices the run against the
     * book's cap and script budget before queuing anything, refuses one that does not fit with a
     * 409 whose sentence the toast below shows as it is, and stops a running job before a request
     * the budget no longer allows — see `docs/backend.md`.
     *
     * Nothing about a chapter changes here. The server marks the chapters it queued, the response
     * carries them as they now stand, and the queue's poll (`useBookJobs`) brings the script, the
     * cast and the history when a run lands. A chapter the server left out — skipped for the
     * audiobook, or already being scripted — is said so in the toast rather than waited for.
     */
    async runScripting(
      bookId: string,
      ids: number[],
      {
        quiet = false,
      }: {
        /** a single-chapter run started from the reader says its own piece; no run summary */
        quiet?: boolean;
      } = {},
    ): Promise<void> {
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "script")) return;
      try {
        const { jobs, skipped, chapters } = await jobsService().scriptChapters(
          bookId,
          ids,
          this.scriptSettings.profile,
        );
        libraryStore.chapters[bookId] = chapters;
        // the queue moved: whoever reads it reads it again, and the poll takes it from there
        await jobsStore._changed();
        if (quiet) return;
        const busy = skipped.filter((s) => s.why === "busy").length;
        const excluded = skipped.filter((s) => s.why === "excluded").length;
        const notes = [
          busy ? `${plural(busy, "chapter")} already being scripted` : "",
          excluded ? `${plural(excluded, "chapter")} skipped for the audiobook` : "",
        ].filter(Boolean);
        if (!jobs.length) {
          uiStore.toast("Nothing to script", {
            kind: "warn",
            description:
              notes.join("; ") || "The selection had no chapters the server could script.",
          });
          return;
        }
        const replacing = jobs.filter((j) => j.bulk?.op === "Re-script").length;
        uiStore.toast(
          `${replacing === jobs.length ? "Re-script" : "Script"} · ${plural(jobs.length, "chapter")}`,
          {
            kind: "info",
            description:
              "Queued on the server. Progress is in the Queue, and each script appears here when it lands." +
              (replacing ? ` ${plural(replacing, "finished script")} will be replaced.` : "") +
              (notes.length ? ` Left out: ${notes.join("; ")}.` : ""),
            timeout: 8000,
          },
        );
      } catch (cause) {
        const api = cause instanceof ApiError ? cause : null;
        uiStore.toast(api ? api.message : "Could not queue scripting", {
          kind: "error",
          description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
          timeout: 8000,
        });
      }
    },
    /**
     * Run the LLM again over a chapter whose chunk fell back to one line. The server scripts a
     * chapter at a time, so it is the whole chapter that is scripted again.
     */
    retryChunk(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const seg = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!seg?.fallback) return;
      void this.runScripting(bookId, [chId], { quiet: true });
    },
  },
});
