// Scripting settings and run coordination. The runs themselves are the server's. Settings travel in
// the endpoint configuration: `_install` fills `scriptSettings`, the write-behind saves them.
import { keyInPlace } from "@/services/endpointSettings";
import { plural } from "@/lib/contents";
import { scriptingPlan } from "@/lib/runPlan";
import { jobsService } from "@/services/jobs";
import { baseRates, ensurePricing, estimateRates } from "@/lib/pricing";
import { resolvePrompt } from "@/lib/prompt";
import {
  DEFAULT_MAX_CHARS,
  makeScriptSettings,
  profileErrors,
  scriptParts,
  tokenEstimator,
} from "@/lib/scripting";
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

/**
 * A chapter's text as it would be sent, cut the way `p` cuts it; `text` is null until read.
 * Cached until the text or cut settings change: the plan reruns over every selected chapter as each
 * text lands. `chapterTextRead` returns the same string per read, so the check is a reference compare.
 */
function chapterCut(bookId: string, chapterId: number, p: Profile | undefined) {
  const text = chapterTextRead(bookId, chapterId, "plain");
  if (text == null || !p) return { text, parts: [] };
  const key = `${bookId}:${chapterId}`;
  const hit = cuts.get(key);
  if (hit?.text === text && hit.maxChars === p.maxChars && hit.splitAt === p.splitAt)
    return { text, parts: hit.parts };
  const parts = scriptParts(text, p);
  cuts.set(key, { text, maxChars: p.maxChars, splitAt: p.splitAt, parts });
  return { text, parts };
}
// ponytail: one entry per chapter cut this session, never evicted; key it by book if memory matters
const cuts = new Map<
  string,
  { text: string; maxChars: number; splitAt: string; parts: string[] }
>();

export const useScriptingStore = defineStore("scripting", {
  state: (): ScriptingState => ({ scriptSettings: makeScriptSettings() }),
  getters: {
    /**
     * The profile a run goes to: the picked one while it exists (paused or not, so the picker and
     * blockers say so), else the first that could take a run.
     */
    runProfile(): Profile | undefined {
      const endpointsStore = useEndpointsStore();

      const { profiles } = endpointsStore;
      return (
        profiles.find((p) => p.id === this.scriptSettings.profile) ??
        profiles.find((p) => p.enabled && !profileErrors(p).length)
      );
    },
    /** `runProfile` while its settings are sound enough to cut a chapter by; none otherwise. */
    cutProfile(): Profile | undefined {
      const p = this.runProfile;
      return p && !profileErrors(p).length ? p : undefined;
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
     * What running the selection would do: new work, replacements, and skipped chapters with why.
     * Replacement is the chapter's server-kept status. An unread chapter counts no requests; the
     * estimate says it is reading.
     */
    scriptPlan(): (bookId: string, ids: number[]) => RunPlan {
      const libraryStore = useLibraryStore();

      return (bookId, ids) => {
        const picked = new Set(ids);
        return scriptingPlan(
          libraryStore.chaptersOf(bookId).filter((c) => picked.has(c.id)),
          (c) => chapterCut(bookId, c.id, this.cutProfile).parts.length,
          isScripted,
        );
      };
    },
    /**
     * What running the selection would cost. `reasoningTokens` is the expected thinking share of
     * output, from the endpoint's recent requests at its current level; none until one reported.
     */
    scriptEstimate(): (
      bookId: string,
      ids: number[],
    ) => ScriptEstimate & { reasoningTokens: number } {
      return (bookId, ids) => this.scriptEstimateOf(bookId, this.scriptPlan(bookId, ids));
    },
    /** `scriptEstimate` from a plan already in hand. */
    scriptEstimateOf(): (
      bookId: string,
      plan: RunPlan,
    ) => ScriptEstimate & { reasoningTokens: number } {
      const endpointsStore = useEndpointsStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();

      return (bookId, plan) => {
        const p = this.runProfile;
        const blockers = [...this.runBlockers];
        if (libraryStore.bookById(bookId)?.budget?.paused)
          blockers.push("This book is paused. Resume it from the overview.");
        // the plan decides which chapters a run would touch; the estimate prices exactly those
        const cut = plan.chapters.map((row) => chapterCut(bookId, row.id, this.cutProfile));
        // an unread chapter is not an empty one: the run waits until it is counted
        const reading = cut.filter((c) => c.text == null).length;
        if (reading) blockers.push(`Reading the text of ${plural(reading, "chapter")}…`);
        // a chapter with nothing to send takes no time
        const parts = cut.map((c) => c.parts).filter((xs) => xs.length);
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
        // the ledger's thinking per input token for this endpoint, when a page has read it
        const reasoningPerInputToken = p
          ? scriptTelemetry(scriptActivityNow(p.id), p).reasoning?.perInputToken
          : undefined;
        // the prompt and the rates are the same for every chunk, so they are worked out once
        const perChunk = parts.length
          ? tokenEstimator(p!, at, { prompt, reasoningPerInputToken })
          : undefined;
        const tokens = perChunk ? parts.flat().map((text) => perChunk(text)) : [];
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
              // the ledger's recent cache rate, when read; the conservative figure ignores it
              recentCacheRate(scriptActivityNow(p.id)),
            )
          : null;
        // A capped book whose spending is unread has an unknown amount left, never all of it.
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
        // A budget is checked against the price with no discount and no cache saving: a promotion
        // can end mid-run. See `estimateRates`.
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
          chapters: plan.chapters.length,
          chars: cut.reduce((n, c) => n + (c.text?.length ?? 0), 0),
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
     * Script the given chapters as one server run; the server enforces the budget (409 with a
     * sentence the toast shows). Chapters it left out are named in the toast. Write-behind edits
     * are flushed first, since the server reads the profile from its database. True when anything
     * was queued. Checks no blockers; every person-started run goes through `startRun`.
     */
    async runScripting(
      bookId: string,
      ids: number[],
      {
        quiet = false,
      }: {
        /** a single-chapter run from the reader says its own piece; no run summary */
        quiet?: boolean;
      } = {},
    ): Promise<boolean> {
      const endpointsStore = useEndpointsStore();
      const jobsStore = useJobsStore();
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "script")) return false;
      try {
        // a refused flush means the server would script with what it kept instead
        if ((await endpointsStore.flushWrites()) === "refused") return false;
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
     * The one way a page or retry queues scripting. Reads the chapters' text, and the book's
     * spending when no page has, then refuses with the reason while the estimate has a blocker.
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
        // a failed read leaves the spending unread, which the estimate then says
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
     * Rescript a chapter in smaller pieces after one failed to verify. The chunk size is the
     * endpoint's, shared by every book, so the toast says so; it is put back if the run cannot start.
     */
    async smallerChunks(bookId: string, chId: number): Promise<void> {
      const uiStore = useUiStore();

      const p = this.runProfile;
      if (!p) return void this.startRun(bookId, [chId]);
      const was = p.maxChars;
      p.maxChars = Math.max(100, (p.maxChars || DEFAULT_MAX_CHARS) - 2000);
      if (!(await this.startRun(bookId, [chId], { quiet: true }))) {
        p.maxChars = was;
        return;
      }
      const n = useLibraryStore().numberOf(bookId, chId);
      uiStore.toast(`Re-scripting ${n ? `chapter ${n}` : "the chapter"} in smaller chunks`, {
        kind: "info",
        description: `${p.name} now cuts chapters at ${p.maxChars.toLocaleString("en")} characters — for every book it scripts, not just this one. Change it on the Endpoints page.`,
        timeout: 8000,
      });
    },
    /** Rescript after a chunk fell back to one line; the server scripts whole chapters. */
    retryChunk(bookId: string, chId: number, segId: number): void {
      const scriptsStore = useScriptsStore();

      const seg = scriptsStore.segmentsOf(bookId, chId).find((x) => x.id === segId);
      if (!seg?.fallback) return;
      void this.startRun(bookId, [chId], { quiet: true });
    },
  },
});
