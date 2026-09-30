// Scripting settings and run coordination. The runs themselves are the server's.
//
// The settings are the server's too: they travel in the endpoint configuration document, so the
// endpoints store's `_install` fills `scriptSettings` and its write-behind saves every change.
import { keyInPlace } from "@/services/endpointSettings";
import { plural } from "@/lib/contents";
import { scriptingPlan } from "@/lib/runPlan";
import { jobsService } from "@/services/jobs";
import { baseRates, ensurePricing, estimateRates } from "@/lib/pricing";
import { resolvePrompt } from "@/lib/prompt";
import { makeScriptSettings, profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import { recentCacheRate, scriptTelemetry } from "@/lib/scriptActivity";
import { isScripted } from "@/lib/scriptReview";
import { chapterTextRead, loadChapterTexts } from "@/queries/chapterTexts";
import { scriptActivityNow } from "@/queries/scriptActivity";
import { fetchSpend } from "@/queries/spend";
import type { Profile, RunPlan, ScriptEstimate, ScriptSettings } from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";
interface ScriptingState {
  scriptSettings: ScriptSettings;
}
export const useScriptingStore = defineStore("scripting", {
  state: (): ScriptingState => ({ scriptSettings: makeScriptSettings() }),
  getters: {
    /**
     * The profile a run goes to: the one picked, while it exists — paused or not, since the picker
     * and the blockers then say so — or else the first that could take a run. None when there is
     * no such profile. Every page that names "the scripting endpoint" reads this one.
     */
    runProfile(): Profile | undefined {
      const endpointsStore = useEndpointsStore();

      const { profiles } = endpointsStore;
      return (
        profiles.find((p) => p.id === this.scriptSettings.profile) ??
        profiles.find((p) => p.enabled && !profileErrors(p).length)
      );
    },
    /** Why `runProfile` cannot take a run, in the words the page shows; none when it can. */
    runBlockers(): string[] {
      const endpointsStore = useEndpointsStore();

      const p = this.runProfile;
      if (!p)
        return [
          endpointsStore.profiles.length
            ? "Every scripting endpoint is paused or needs its settings checked. Enable one, or fix it on the Endpoints page."
            : "Add a scripting endpoint to run scripting.",
        ];
      const blockers = profileErrors(p);
      if (!p.enabled) blockers.push("This endpoint is paused. Enable it or select another.");
      if (p.needsKey && !keyInPlace(p)) blockers.push("Add an API key in endpoint settings.");
      return blockers;
    },
    /**
     * What running the current selection would do: which chapters are new work, which replace a
     * script that is already finished, and which are left out and why. The picker's summary, the
     * button's label and the estimate all read this. Whether a chapter has a script to replace is
     * its own status, which the server keeps: a re-script that fails leaves it reading as scripted.
     * A chapter whose text has not been read yet counts no requests; the estimate says it is
     * reading rather than letting that pass for a free chapter.
     */
    scriptPlan(): (bookId: string, ids: number[]) => RunPlan {
      const libraryStore = useLibraryStore();

      return (bookId, ids) => {
        const p = this.runProfile;
        const usable = p && !profileErrors(p).length;
        return scriptingPlan(
          libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id)),
          (c) => (usable ? scriptParts(chapterTextRead(bookId, c.id, "plain") ?? "", p).length : 0),
          isScripted,
        );
      };
    },
    /**
     * What running the selection would cost. `reasoningTokens` is the share of the output a
     * reasoning model is expected to spend thinking, from what the endpoint's recent requests at
     * its current level reported — none until one did.
     */
    scriptEstimate(): (
      bookId: string,
      ids: number[],
    ) => ScriptEstimate & { reasoningTokens: number } {
      const endpointsStore = useEndpointsStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      return (bookId: string, ids: number[]): ScriptEstimate & { reasoningTokens: number } => {
        // the plan decides which chapters a run would touch; the estimate prices exactly those
        const chs = this.scriptPlan(bookId, ids).chapters.map((row) =>
          libraryStore.chapter(bookId, row.id)!,
        );
        const p = this.runProfile;
        const blockers = [...this.runBlockers];
        if (libraryStore.bookById(bookId)?.budget?.paused)
          blockers.push("This book is paused. Resume it from the overview.");
        // a chapter not read yet is not a chapter with no text: the run waits until it is counted
        const read = chs.map((c) => chapterTextRead(bookId, c.id, "plain"));
        const reading = read.filter((t) => t == null).length;
        if (reading) blockers.push(`Reading the text of ${plural(reading, "chapter")}…`);
        const texts = read.map((t) => t ?? "");
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
        // what the ledger says this endpoint thinks per input token, when a page has read it
        const reasoningPerInputToken = p
          ? scriptTelemetry(scriptActivityNow(p.id), p).reasoning?.perInputToken
          : undefined;
        const tokens = parts
          .flat()
          .map((text) => tokenEstimate(text, p!, at, { prompt, reasoningPerInputToken }));
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
        // What the book may still spend, from what the server's ledger says it has. A book with
        // a cap whose spending has not been read yet has an unknown amount left, never all of it.
        const book = libraryStore.bookById(bookId);
        const capped = book?.scriptBudget != null || book?.budget?.cap != null;
        const spend = jobsStore.spendOf(bookId);
        if (capped && !spend) blockers.push("Reading what this book has spent…");
        const scriptingRemaining =
          (book?.scriptBudget ?? Infinity) -
          (spend?.scriptSpent ?? 0) -
          (spend?.scriptReserved ?? 0);
        const overallRemaining =
          (book?.budget?.cap ?? Infinity) - (spend?.spent ?? 0) - (spend?.scriptReserved ?? 0);
        const remaining = capped && !spend ? NaN : Math.min(scriptingRemaining, overallRemaining);
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
          reasoningTokens: tokens.reduce((n, t) => n + t.reasoningTokens, 0),
          inputCost,
          outputCost,
          cost: inputCost + outputCost,
          profile: p,
          rates,
          blockers,
          remaining,
          reading,
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
     *
     * The server reads the profile from its own database, so every edit the endpoints store's
     * write-behind holds or has out — a smaller chunk size a moment ago — lands first; the run
     * would otherwise go out on the settings from before it. True when anything was queued.
     *
     * This checks nothing the page shows as a blocker: every run a person starts, a retry from the
     * Queue included, goes through `startRun`.
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
    ): Promise<boolean> {
      const endpointsStore = useEndpointsStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "script")) return false;
      try {
        await endpointsStore.flushWrites();
        const { jobs, skipped, chapters } = await jobsService().scriptChapters(
          bookId,
          ids,
          this.runProfile?.id,
        );
        libraryStore.chapters[bookId] = chapters;
        // the queue moved: whoever reads it reads it again, and the poll takes it from there
        await jobsStore._changed();
        if (quiet) return jobs.length > 0;
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
          return false;
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
        return true;
      } catch (cause) {
        toastFailure("queue scripting", cause);
        return false;
      }
    },
    /**
     * Start a run from a button: the one way a page or a retry queues scripting. It reads the
     * chapters' text first, so what it checks is priced on what the run would send, and the book's
     * spending when no page has — a retry from the Queue may be of a book no page has open — and
     * then refuses, saying why, while the estimate has any blocker, the same ones the page shows
     * beside the button. No button can start a run the estimate would not, whichever page it is on.
     */
    async startRun(
      bookId: string,
      ids: number[],
      opts: { quiet?: boolean } = {},
    ): Promise<boolean> {
      const jobsStore = useJobsStore();
      const uiStore = useUiStore();

      await Promise.all([
        loadChapterTexts(bookId, ids, "plain"),
        // a read that fails leaves the spending unread, which the estimate then says
        jobsStore.spendOf(bookId) ? undefined : fetchSpend(bookId).catch(() => {}),
      ]);
      const { blockers } = this.scriptEstimate(bookId, ids);
      if (blockers.length) {
        uiStore.toast("Scripting can’t start yet", {
          kind: "warn",
          description: blockers.join(" "),
          timeout: 8000,
        });
        return false;
      }
      return this.runScripting(bookId, ids, opts);
    },
    /**
     * Script a chapter again in smaller pieces, after one failed to verify. The chunk size is the
     * endpoint's, shared by every book it scripts, so the toast says so; the change is put back if
     * the run could not start, since nothing then asked for it.
     */
    async smallerChunks(bookId: string, chId: number): Promise<void> {
      const uiStore = useUiStore();

      const p = this.runProfile;
      if (!p) return void this.startRun(bookId, [chId]);
      const was = p.maxChars;
      p.maxChars = Math.max(100, (p.maxChars || 6000) - 2000);
      if (!(await this.startRun(bookId, [chId], { quiet: true }))) {
        p.maxChars = was;
        return;
      }
      uiStore.toast(`Re-scripting chapter ${chId} in smaller chunks`, {
        kind: "info",
        description: `${p.name} now cuts chapters at ${p.maxChars.toLocaleString("en")} characters — for every book it scripts, not just this one. Change it on the Endpoints page.`,
        timeout: 8000,
      });
    },
    /**
     * Run the LLM again over a chapter whose chunk fell back to one line. The server scripts a
     * chapter at a time, so it is the whole chapter that is scripted again.
     */
    retryChunk(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const seg = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!seg?.fallback) return;
      void this.startRun(bookId, [chId], { quiet: true });
    },
  },
});
