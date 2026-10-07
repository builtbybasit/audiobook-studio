// Shared queue and accounting across books and stages. IDs are scoped to this Pinia instance.
//
// This store is the queue's side of the seam in `@/services/jobs`. The jobs are the server's and
// nothing here edits them: `useBookJobs` in `@/queries` reads them, polls while anything is live,
// and `jobs` is that read as the query cache holds it. A cancel, a remove or a clear is a request
// that then invalidates it. A book's spending is read the same way (`useBookSpend`,
// `useLibrarySpend`), and `spendOf` answers from whichever of those reads holds the book.
import { useQueryCache } from "@pinia/colada";
import { plural } from "@/lib/contents";
import { usable } from "@/lib/exports";
import { jobLabel } from "@/lib/queue";
import { segmentFailed } from "@/lib/runPlan";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { jobsService } from "@/services/jobs";
import type { BookSpend, CheckQueued, EndpointLoad, Eta, Job, JobKind } from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";
const AVG_JOB: Record<JobKind, number> = { scripting: 25, narration: 60, export: 120, check: 15 };

/** The queue before it has been read. */
const NO_JOBS: readonly Job[] = [];

export const useJobsStore = defineStore("jobs", {
  state: () => ({}),
  getters: {
    /** The queue as the server last listed it; none before the first read. */
    jobs(): Job[] {
      return (useQueryCache().getQueryData<Job[]>(keys.jobs) ?? NO_JOBS) as Job[];
    },
    /**
     * What a book has spent and holds, as the server's ledger last said: the book's own read
     * (`useBookSpend`) when there is one, else the library's (`useLibrarySpend`). Undefined until
     * one of them has read it — which is not the same as having spent nothing.
     */
    spendOf(): (bookId: string) => BookSpend | undefined {
      const queryCache = useQueryCache();
      return (bookId) => {
        const own = queryCache.getQueryData<BookSpend>(keys.spend(bookId));
        if (own) return own;
        for (const entry of queryCache.getEntries({ key: keys.librarySpend })) {
          const all = entry.state.value.data as Record<string, BookSpend> | undefined;
          if (all?.[bookId]) return all[bookId];
        }
        return undefined;
      };
    },
    activeJobs(): Job[] {
      return this.jobs.filter((j) => j.status === "running" || j.status === "queued");
    },
    /**
     * Each speech endpoint's busy slots, and the clips it has done and failed across the library,
     * all as the server counts them (`useEndpointLive`): the gate counts every job's lines, and the
     * clips are counted from what is stored, not from the chapters this browser has read.
     */
    endpointLoad(): Record<string, EndpointLoad> {
      const endpointsStore = useEndpointsStore();

      return Object.fromEntries(
        endpointsStore.endpoints.map((e) => {
          const live = endpointsStore.serverLoad(e.id);
          return [
            e.id,
            {
              active: live.active,
              done: live.done ?? 0,
              failed: live.failed ?? 0,
              backoff: e.backoffUntil > Date.now(),
            },
          ];
        }),
      );
    },
    /** Every job of one bulk run, in the order the run asked for them. */
    runJobs(): (runId: number) => Job[] {
      return (runId: number): Job[] =>
        this.jobs
          .filter((j) => j.bulk?.id === runId)
          .sort((a, b) => (a.bulk!.index ?? 0) - (b.bulk!.index ?? 0));
    },
    /**
     * A job's label as a page shows it: the server's, which names no chapter, with the chapter's
     * reading number put in (`jobLabel`) once its book's chapters are read.
     */
    labelOf(): (j: Job) => string {
      const libraryStore = useLibraryStore();
      return (j) =>
        jobLabel(
          j.label,
          j.chapterId == null ? undefined : libraryStore.chapterRef(j.bookId, j.chapterId),
        );
    },
    recentJobs(): Job[] {
      return [...this.jobs].reverse().slice(0, 12);
    },
    // The four figures below are what every budget panel, gate and wait reason reads. They are the
    // server's (`spendOf`, read from its ledger and its queue), because the server prices every
    // request and holds every reservation, and a job carries no reservation of its own to add up.
    // Each is undefined until the book's spending has been read: a page says it does not know yet
    // rather than showing a budget with nothing spent.
    scriptSpent(): (bookId: string) => number | undefined {
      return (bookId) => this.spendOf(bookId)?.scriptSpent;
    },
    scriptReserved(): (bookId: string) => number | undefined {
      return (bookId) => this.spendOf(bookId)?.scriptReserved;
    },
    /**
     * Everything held against this book's cap by work that has not landed yet, of either stage.
     * Two runs that each fit on their own must not both be allowed to start and overshoot together,
     * so a reservation is what stops the second one rather than the first one's spending.
     */
    reserved(): (bookId: string) => number | undefined {
      return (bookId) => this.spendOf(bookId)?.reserved;
    },
    /**
     * What this book has cost, of both stages.
     *
     * Read out of the server's append-only ledger, not off the clips the book is holding now.
     * Totalling the current clip of each line lost every request that had been paid for and then
     * superseded — a failed render, a rejected take, the recording a retake displaced — so
     * accepting a retake made recorded spending *fall* and handed the budget back capacity it had
     * really used.
     */
    spent(): (bookId: string) => number | undefined {
      return (bookId) => this.spendOf(bookId)?.spent;
    },
    eta(): Eta | null {
      const hist: Partial<Record<JobKind, number[]>> = {};
      for (const j of this.jobs)
        if (j.status === "done" && j.startedAt && j.finishedAt)
          (hist[j.kind] ??= []).push((j.finishedAt - j.startedAt) / 1000);
      const avg = (k: JobKind): number => {
        const h = hist[k];
        return h?.length ? h.reduce((a, b) => a + b, 0) / h.length : (AVG_JOB[k] ?? 60);
      };
      const perBook: Record<string, number> = {};
      for (const j of this.jobs) {
        if (j.status !== "running" && j.status !== "queued") continue;
        const secs =
          j.status === "queued" ? avg(j.kind) : avg(j.kind) * (1 - (j.progress ?? 0) / 100);
        perBook[j.bookId] = (perBook[j.bookId] ?? 0) + secs;
      }
      const seconds = Math.max(0, ...Object.values(perBook));
      return Object.keys(perBook).length
        ? { seconds, at: Date.now() + seconds * 1000, books: Object.keys(perBook).length }
        : null;
    },
  },
  actions: {
    // ---------- the seam ----------
    /**
     * The queue changed on the server — something was queued, cancelled or cleared — so whoever
     * is reading it reads it again. The poll notices from there what else has to follow.
     */
    _changed(): Promise<void> {
      return invalidate({ key: keys.jobs });
    },
    // ---------- shared ----------
    /**
     * Stop the rest of a bulk run. Chapters it already finished keep their results — that is the
     * whole point of cancelling one rather than undoing it — and chapters still to come never
     * start, so nothing half-replaces anything.
     */
    cancelRun(runId: number): number {
      const pending = this.runJobs(runId).filter((j) => !j.finishedAt);
      this.cancelJobs(pending.map((j) => j.id));
      return pending.length;
    },
    /**
     * Try the chapters of one run that failed, and only those — as one run again, so the retry has
     * a run of its own to watch and cancel rather than becoming N unrelated single-chapter runs.
     * The scope is the narrowest one that covers the failure, so nothing that succeeded is redone.
     * A retry is a run like any other, held to the blockers its page shows (`startRun`).
     */
    retryRunFailures(runId: number): number {
      const narrationStore = useNarrationStore();
      const scriptingStore = useScriptingStore();

      const failed = this.runJobs(runId).filter(
        (j) => j.status === "failed" && j.chapterId !== null,
      );
      if (!failed.length) return 0;
      const ids = [...new Set(failed.map((j) => j.chapterId!))];
      const { kind, bookId } = failed[0]; // one press, one book, one stage
      switch (kind) {
        case "scripting":
          void scriptingStore.startRun(bookId, ids, { quiet: true });
          break;
        case "narration":
          void narrationStore.startRun(bookId, ids, { scope: "failed", quiet: true });
          break;
        case "check":
          void this.checkChapters(bookId, ids, { quiet: true });
          break;
        case "export":
          for (const j of failed) this.retryJob(j.id);
      }
      return failed.length;
    },
    /**
     * Hear these chapters' current clips, as one run: the server sends each to the first
     * transcription endpoint switched on, and flags a line whose clip says something else. It
     * leaves out a chapter with no clip to hear, one whose clips were all heard already, and one
     * already being narrated or checked, and the toast says which. With no transcription endpoint
     * switched on the server refuses the whole run, and its sentence is the toast. Chapters left
     * out as already heard can be heard again from the toast (`again`: every clip, those already
     * heard too). True when anything was queued.
     */
    async checkChapters(
      bookId: string,
      ids: number[],
      { quiet = false, again = false }: { quiet?: boolean; again?: boolean } = {},
    ): Promise<boolean> {
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "check it by ear")) return false;
      let queued: CheckQueued;
      try {
        queued = await jobsService().checkChapters(bookId, ids, again);
      } catch (cause) {
        toastFailure("queue the check", cause);
        return false;
      }
      const { jobs, skipped, chapters } = queued;
      libraryStore.chapters[bookId] = chapters;
      await this._changed();
      if (quiet) return jobs.length > 0;
      const WHY: Record<(typeof skipped)[number]["why"], string> = {
        unnarrated: "not narrated yet",
        nothing: "already heard",
        busy: "already being narrated or checked",
        excluded: "skipped for the audiobook",
        missing: "no longer in the book",
      };
      const notes = (Object.keys(WHY) as (keyof typeof WHY)[])
        .map((why) => [why, skipped.filter((s) => s.why === why).length] as const)
        .filter(([, n]) => n)
        .map(([why, n]) => `${plural(n, "chapter")} ${WHY[why]}`);
      const heard = skipped.filter((s) => s.why === "nothing").map((s) => s.id);
      const action = heard.length
        ? {
            label: "Check again",
            run: () => void this.checkChapters(bookId, heard, { again: true }),
          }
        : null;
      if (!jobs.length) {
        uiStore.toast("Nothing to check in this selection", {
          kind: "warn",
          description: notes.join("; ") || "The selection had no clips the server could hear.",
          action,
        });
        return false;
      }
      uiStore.toast(`Check by ear · ${plural(jobs.length, "chapter")}`, {
        kind: "info",
        description:
          "Queued on the server. Progress is in the Queue, and a line heard saying something else is flagged." +
          (notes.length ? ` Left out: ${notes.join("; ")}.` : ""),
        timeout: 8000,
        action,
      });
      return true;
    },
    removeJob(id: number): void {
      const j = this.jobs.find((j) => j.id === id);
      if (!j || !(j.finishedAt || j.status === "queued")) return;
      const svc = jobsService();
      // a queued job is cancelled first, which settles it, and then it can go
      void (j.status === "queued" ? svc.cancel(id) : Promise.resolve())
        .then(() => svc.remove(id))
        .catch((cause: unknown) => toastFailure("remove this job", cause))
        // the cancel may have gone through even when the remove did not
        .finally(() => this._changed());
    },
    /** Move queued jobs — one, or a whole run's — ahead of everything else waiting. */
    runNext(ids: number[]): void {
      if (!ids.length) return;
      void jobsService()
        .runNext(ids)
        .then(() => this._changed())
        .catch((cause: unknown) => toastFailure("move these jobs up", cause));
    },
    cancelJob(id: number): void {
      this.cancelJobs([id]);
    },
    /**
     * Stop these jobs, in one request however many — a run can be hundreds of chapters.
     *
     * The server's jobs, so the server stops them, and the queue and their chapters are read again
     * after. Nothing is marked locally first — a cancel that failed to reach the server must not
     * look like one that worked.
     */
    cancelJobs(ids: number[]): void {
      const live = ids.filter((id) => {
        const job = this.jobs.find((j) => j.id === id);
        return job && !job.finishedAt && !job.cancelled;
      });
      if (!live.length) return;
      void jobsService()
        .cancelMany(live)
        .then(() => this._changed())
        .catch((cause: unknown) =>
          toastFailure(live.length === 1 ? "cancel this job" : "cancel these jobs", cause),
        );
    },
    retryJob(id: number): void {
      const exportsStore = useExportsStore();
      const libraryStore = useLibraryStore();
      const narrationStore = useNarrationStore();
      const scriptingStore = useScriptingStore();
      const scriptsStore = useScriptsStore();

      const job = this.jobs.find((j) => j.id === id);
      if (!job) return;
      if (job.kind === "export") {
        const run = job.exportRun;
        if (!run) return;
        const failed = exportsStore.exports.find(
          (e) => e.id === run.exportId && e.status === "failed",
        );
        if (failed) return void exportsStore.retryExport(failed.id);
        // a cancelled build left nothing behind: start it again from the settings it carried
        const ids = run.chapterIds.filter((cid) => {
          const c = libraryStore.chapter(job.bookId, cid);
          return c && usable(c);
        });
        const stale = ids.some(
          (cid) => libraryStore.chapter(job.bookId, cid)?.narration === "stale",
        );
        void exportsStore.buildExport(
          job.bookId,
          ids,
          { ...run.settings, useStale: run.settings.useStale || stale },
          { updates: run.updates ?? undefined },
        );
        return;
      }
      if (job.chapterId == null) return;
      switch (job.kind) {
        case "scripting":
          void scriptingStore.startRun(job.bookId, [job.chapterId], { quiet: true });
          return;
        // a check hears what the chapter holds now, and the server leaves out what was heard already
        case "check":
          void this.checkChapters(job.bookId, [job.chapterId], { quiet: true });
          return;
        case "narration": {
          const c = libraryStore.chapter(job.bookId, job.chapterId);
          if (!c) return;
          // A retry renders what failed, never what already worked. A replacement that failed
          // counts as a failure even though the chapter still reads as narrated — its own clip was
          // never touched — so the failures are looked for on the clips, not on the chapter's status.
          const failed = scriptsStore.segmentsOf(job.bookId, c.id).some(segmentFailed);
          void narrationStore.startRun(job.bookId, [c.id], {
            scope: failed ? "failed" : "fill",
            quiet: true,
          });
        }
      }
    },
    /** Did a later run of the same stage finish this chapter's work? Then this failure is old news. */
    _supersededBy(job: Job): boolean {
      return this.jobs.some(
        (x) =>
          x.id !== job.id &&
          x.kind === job.kind &&
          x.bookId === job.bookId &&
          x.chapterId === job.chapterId &&
          x.status === "done" &&
          (x.finishedAt ?? 0) > (job.finishedAt ?? 0),
      );
    },
    clearFinished(): void {
      void jobsService()
        .clear()
        .then(() => this._changed())
        .catch((cause: unknown) => toastFailure("clear the history", cause));
    },
    cancelAll(): void {
      // the waiting ones first, so stopping the running one does not let the next one start
      const ids = (status: Job["status"]) =>
        this.jobs.filter((j) => j.status === status).map((j) => j.id);
      this.cancelJobs([...ids("queued"), ...ids("running")]);
    },
    /**
     * The failed jobs "Retry all failed" would actually re-run — one per chapter, newest kept.
     *
     * Asked of the work and the queue, never of the chapter's label: a re-script that failed puts
     * the chapter's status back to what it was, and a chapter whose *replacements* failed still
     * reads as narrated because the book's own clips were never touched, so in both cases
     * "did this chapter end up failed" cannot say whether this job's work is still missing. What can
     * is the queue — the chapter must not already be busy, and a later run that already did the work
     * makes this failure old news, so retrying past it would re-send requests the ledger has been
     * charged for once already.
     *
     * The queue's "Retry failed (N)" button reads this list, so the count it offers and the work the
     * button does are the same answer.
     */
    retryableFailures(): Job[] {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      // One retry per chapter, and it must be the chapter's **most recent** failure: jobs are
      // appended, so walking them oldest-first would let a stale failure that a later run already
      // made good claim the chapter, be discarded by `_supersededBy`, and take the current failure
      // with it — leaving a chapter with failed clips out of both the count and the retry.
      const seen = new Set<string>();
      const out: Job[] = [];
      for (const j of this.jobs
        .filter((j) => j.status === "failed" && j.kind !== "export")
        .reverse()) {
        const key = `${j.kind}:${j.bookId}:${j.chapterId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = j.chapterId == null ? undefined : libraryStore.chapter(j.bookId, j.chapterId);
        if (!c || this._supersededBy(j)) continue;
        const busy = (stage: "scripting" | "narration") => ["queued", "running"].includes(c[stage]);
        const still: Record<JobKind, () => boolean> = {
          scripting: () => !busy("scripting"),
          narration: () =>
            scriptsStore.segmentsOf(j.bookId, c.id).some(segmentFailed) && !busy("narration"),
          // a chapter carries no check status of its own, so the queue says whether one is on it
          check: () =>
            !busy("narration") &&
            !this.activeJobs.some(
              (x) => x.kind === "check" && x.bookId === j.bookId && x.chapterId === j.chapterId,
            ),
          // filtered out above: a build is retried from its own row, by the settings it carried
          export: () => false,
        };
        if (still[j.kind]()) out.push(j);
      }
      // scanned newest-first to pick the right job per chapter; handed back in queue order, so a
      // retry of several chapters submits them the way they were originally run
      return out.reverse();
    },
    retryAllFailed(): void {
      for (const j of this.retryableFailures()) this.retryJob(j.id);
    },
  },
});
