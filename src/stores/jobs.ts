// Shared queue and accounting across books and stages. IDs are scoped to this Pinia instance.
// The jobs are the server's (`useBookJobs` reads and polls them); cancel, remove and clear are
// requests that invalidate that read. Spending comes from `useBookSpend` or `useLibrarySpend`.
import { useQueryCache } from "@pinia/colada";
import { plural } from "@/lib/contents";
import { usable } from "@/lib/exports";
import { jobLabel } from "@/lib/queue";
import { segmentFailed } from "@/lib/runPlan";
import { fetchScript } from "@/queries/chapterScript";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { jobsService } from "@/services/jobs";
import { libraryService } from "@/services/library";
import type { BookSpend, TranscribeQueued, EndpointLoad, Eta, Job, JobKind } from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";
import { useUiStore } from "@/stores/ui";
const AVG_JOB: Record<JobKind, number> = {
  scripting: 25,
  narration: 60,
  export: 120,
  transcribe: 15,
  effects: 120,
  facts: 20,
  profiles: 60,
};

const NO_JOBS: readonly Job[] = [];

/** Whether a Retry can run this job again: a build from its row, a chapter's job as a new run. */
export const retriable = (j: Job): boolean =>
  j.kind === "export" ? !!j.exportRun : j.chapterId != null && (j.kind !== "facts" || !!j.factsRun);

export const useJobsStore = defineStore("jobs", {
  state: () => ({}),
  getters: {
    /** The queue as the server last listed it; none before the first read. */
    jobs(): Job[] {
      return (useQueryCache().getQueryData<Job[]>(keys.jobs) ?? NO_JOBS) as Job[];
    },
    /**
     * The server's ledger for a book, from `useBookSpend` else `useLibrarySpend`. Undefined until
     * read, which is not the same as nothing spent.
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
    /** Each speech endpoint's busy slots and done/failed clips across the library, as the server counts. */
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
    /** The server's label (no chapter) with the chapter's reading number put in (`jobLabel`). */
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
    // The four budget figures below are the server's (`spendOf`): it prices every request and
    // holds every reservation. Undefined until the book's spending is read.
    scriptSpent(): (bookId: string) => number | undefined {
      return (bookId) => this.spendOf(bookId)?.scriptSpent;
    },
    scriptReserved(): (bookId: string) => number | undefined {
      return (bookId) => this.spendOf(bookId)?.scriptReserved;
    },
    /**
     * Held against this book's cap by unlanded work of either stage, so two runs that each fit
     * cannot both start and overshoot.
     */
    reserved(): (bookId: string) => number | undefined {
      return (bookId) => this.spendOf(bookId)?.reserved;
    },
    /**
     * What this book has cost, from the server's append-only ledger, not the current clips:
     * superseded requests (failed renders, rejected or displaced takes) were paid for too.
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
    /** The queue changed on the server, so whoever reads it reads again. */
    _changed(): Promise<void> {
      return invalidate({ key: keys.jobs });
    },
    // ---------- shared ----------
    /** Stop the rest of a bulk run. Finished chapters keep their results; the rest never start. */
    cancelRun(runId: number): number {
      const pending = this.runJobs(runId).filter((j) => !j.finishedAt);
      this.cancelJobs(pending.map((j) => j.id));
      return pending.length;
    },
    /**
     * Retry a run's failed chapters as one new run, at the narrowest scope covering the failure,
     * held to the same blockers as any run (`startRun`).
     */
    retryRunFailures(runId: number): number {
      const failed = this.runJobs(runId).filter(
        (j) => j.status === "failed" && j.chapterId !== null && retriable(j),
      );
      this._retry(failed);
      return failed.length;
    },
    /**
     * Run these jobs' chapters again, one run per book and stage (a build retries from its own
     * row). Never one request per chapter: each would be its own run and budget check.
     */
    _retry(jobs: readonly Job[]): void {
      const scriptingStore = useScriptingStore();

      const runs = new Map<
        string,
        { kind: JobKind; bookId: string; ids: number[]; facts?: Job["factsRun"] }
      >();
      for (const j of jobs) {
        if (j.kind === "export") {
          this.retryJob(j.id);
          continue;
        }
        if (j.chapterId == null) continue;
        // facts go again on the endpoint and speakers they were read for
        const k = `${j.kind}:${j.bookId}:${j.factsRun?.profile ?? ""}:${j.factsRun?.major ?? ""}`;
        const run = runs.get(k) ?? { kind: j.kind, bookId: j.bookId, ids: [], facts: j.factsRun };
        runs.set(k, run);
        if (!run.ids.includes(j.chapterId)) run.ids.push(j.chapterId);
      }
      for (const { kind, bookId, ids, facts } of runs.values())
        if (kind === "scripting") void scriptingStore.startRun(bookId, ids, { quiet: true });
        else if (kind === "facts" && facts) void this._retryFacts(bookId, ids, facts);
        // a transcription hears what the chapter holds now; the server skips what was heard already
        else if (kind === "transcribe") void this.transcribeChapters(bookId, ids, { quiet: true });
        else if (kind === "narration") void this._retryNarration(bookId, ids);
    },
    async _retryFacts(
      bookId: string,
      chapters: number[],
      { profile, major }: NonNullable<Job["factsRun"]>,
    ): Promise<void> {
      try {
        await libraryService().refreshProfiles(bookId, { profile, chapters, major });
      } catch (cause) {
        toastFailure("read the chapters for cast facts again", cause);
      }
      void invalidate({ key: keys.jobs });
    },
    /**
     * Failed lines are asked of the scripts, read first where no page has (a failed replacement
     * leaves the chapter reading as narrated): those chapters at the failed scope, the rest (a run
     * stopped before their lines went) at missing & changed. One run per scope.
     */
    async _retryNarration(bookId: string, ids: readonly number[]): Promise<void> {
      const narrationStore = useNarrationStore();
      const scriptsStore = useScriptsStore();

      await Promise.all(
        ids
          .filter((id) => !scriptsStore.held(bookId, id))
          .map((id) => fetchScript(bookId, id).catch(() => {})),
      );
      const failed = ids.filter((id) => scriptsStore.segmentsOf(bookId, id).some(segmentFailed));
      const rest = ids.filter((id) => !failed.includes(id));
      if (failed.length)
        await narrationStore.startRun(bookId, failed, { scope: "failed", quiet: true });
      if (rest.length) await narrationStore.startRun(bookId, rest, { scope: "fill", quiet: true });
    },
    /**
     * Transcribe these chapters' clips as one run: the server transcribes each with the first
     * transcriber on and flags lines that differ. Skipped chapters are named in the toast, and
     * already-heard ones can be heard `again` from it. True when anything was queued.
     */
    async transcribeChapters(
      bookId: string,
      ids: number[],
      { quiet = false, again = false }: { quiet?: boolean; again?: boolean } = {},
    ): Promise<boolean> {
      const libraryStore = useLibraryStore();
      const uiStore = useUiStore();

      if (libraryStore._blocked(bookId, "transcribe it")) return false;
      let queued: TranscribeQueued;
      try {
        queued = await jobsService().transcribeChapters(bookId, ids, again);
      } catch (cause) {
        toastFailure("queue the transcription", cause);
        return false;
      }
      const { jobs, skipped, chapters } = queued;
      libraryStore.chapters[bookId] = chapters;
      await this._changed();
      if (quiet) return jobs.length > 0;
      const WHY: Record<(typeof skipped)[number]["why"], string> = {
        unnarrated: "not narrated yet",
        nothing: "already heard",
        busy: "already being narrated or transcribed",
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
            label: "Transcribe again",
            run: () => void this.transcribeChapters(bookId, heard, { again: true }),
          }
        : null;
      if (!jobs.length) {
        uiStore.toast("Nothing to transcribe in this selection", {
          kind: "warn",
          description: notes.join("; ") || "The selection had no clips the server could hear.",
          action,
        });
        return false;
      }
      uiStore.toast(`Transcribe · ${plural(jobs.length, "chapter")}`, {
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
    /** Move queued jobs (one, or a whole run's) ahead of everything else waiting. */
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
     * Stop these jobs in one request (a run can be hundreds). Nothing is marked locally first: a
     * cancel that never reached the server must not look like one that worked.
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
      if (job.chapterId != null) this._retry([job]);
    },
    /** Whether a later run of the same stage finished this chapter's work, making this failure old. */
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
     * The failed jobs "Retry failed (N)" would re-run, one per chapter. Judged from the queue, not
     * the chapter's status (a failed re-script or failed replacements leave it looking fine): the
     * chapter must not be busy, and a later run that did the work makes the failure old news.
     */
    retryableFailures(): Job[] {
      const libraryStore = useLibraryStore();

      // One retry per chapter, from its most recent failure: walking oldest-first would let a
      // superseded failure claim the chapter and drop the current one.
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
          // whether lines failed or were never sent, the retry reads the script to see which
          narration: () => !busy("narration"),
          // a chapter carries no transcription status, so the queue says whether one is on it
          transcribe: () =>
            !busy("narration") &&
            !this.activeJobs.some(
              (x) =>
                x.kind === "transcribe" && x.bookId === j.bookId && x.chapterId === j.chapterId,
            ),
          // a build is retried from its own row, by the settings it carried
          export: () => false,
          // a Re-apply is the whole book's, with no chapter
          effects: () => false,
          // run again by the Cast page's Refresh profiles, which also queues the rewrite
          facts: () => false,
          profiles: () => false,
        };
        if (still[j.kind]()) out.push(j);
      }
      // scanned newest-first; returned in queue order so a retry submits chapters as first run
      return out.reverse();
    },
    retryAllFailed(): void {
      this._retry(this.retryableFailures());
    },
  },
});
