// Shared queue and accounting across books and stages. IDs are scoped to this Pinia instance.
//
// This store is the queue's side of the seam in `@/services/jobs`. The jobs are the server's:
// `useBookJobs` in `@/queries` reads them from it, polls while anything is live and installs each
// read here, and a cancel, a remove or a clear is a request that then invalidates that read.
import { usable } from "@/lib/exports";
import { segmentFailed } from "@/lib/runPlan";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { ApiError } from "@/services/http";
import { jobsService } from "@/services/jobs";
import type { BookSpend, EndpointLoad, Eta, Job, JobKind } from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
const AVG_JOB: Record<JobKind, number> = { scripting: 25, narration: 60, export: 120 };

interface JobsState {
  jobs: Job[];
  /**
   * What each book has spent and holds, as the server's ledger last said — what `useBookSpend`
   * and `useLibrarySpend` install.
   */
  spend: Record<string, BookSpend>;
}
export const useJobsStore = defineStore("jobs", {
  // the queue starts empty and is read from the server
  state: (): JobsState => ({ jobs: [], spend: {} }),
  getters: {
    activeJobs(s): Job[] {
      return s.jobs.filter((j) => j.status === "running" || j.status === "queued");
    },
    /**
     * Each speech endpoint's busy slots, and the clips it has done and failed in the chapters this
     * browser has loaded. The busy count is the server's gate's, which counts every job's lines.
     */
    endpointLoad(): Record<string, EndpointLoad> {
      const endpointsStore = useEndpointsStore();
      const scriptsStore = useScriptsStore();

      const load: Record<string, EndpointLoad> = Object.fromEntries(
        endpointsStore.endpoints.map((e) => [
          e.id,
          {
            active: endpointsStore.serverLoad(e.id)?.active ?? 0,
            done: 0,
            failed: 0,
            backoff: e.backoffUntil > Date.now(),
          },
        ]),
      );
      for (const segs of Object.values(scriptsStore.segments))
        for (const seg of segs) {
          const l = seg.audio.endpoint ? load[seg.audio.endpoint] : undefined;
          if (!l) continue;
          if (seg.audio.status === "done") l.done++;
          else if (seg.audio.status === "failed") l.failed++;
        }
      return load;
    },
    /** Every job of one bulk run, in the order the run asked for them. */
    runJobs(s): (runId: number) => Job[] {
      return (runId: number): Job[] =>
        s.jobs
          .filter((j) => j.bulk?.id === runId)
          .sort((a, b) => (a.bulk!.index ?? 0) - (b.bulk!.index ?? 0));
    },
    recentJobs(s): Job[] {
      return [...s.jobs].reverse().slice(0, 12);
    },
    // The four figures below are what every budget panel, gate and wait reason reads. They are the
    // server's (`spend`, read from its ledger and its queue), because the server prices every
    // request and holds every reservation, and a job carries no reservation of its own to add up.
    scriptSpent(s): (bookId: string) => number {
      return (bookId) => s.spend[bookId]?.scriptSpent ?? 0;
    },
    scriptReserved(s): (bookId: string) => number {
      return (bookId) => s.spend[bookId]?.scriptReserved ?? 0;
    },
    /**
     * Everything held against this book's cap by work that has not landed yet, of either stage.
     * Two runs that each fit on their own must not both be allowed to start and overshoot together,
     * so a reservation is what stops the second one rather than the first one's spending.
     */
    reserved(s): (bookId: string) => number {
      return (bookId) => s.spend[bookId]?.reserved ?? 0;
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
    spent(s): (bookId: string) => number {
      return (bookId) => s.spend[bookId]?.spent ?? 0;
    },
    eta(s): Eta | null {
      const hist: Partial<Record<JobKind, number[]>> = {};
      for (const j of s.jobs)
        if (j.status === "done" && j.startedAt && j.finishedAt)
          (hist[j.kind] ??= []).push((j.finishedAt - j.startedAt) / 1000);
      const avg = (k: JobKind): number => {
        const h = hist[k];
        return h?.length ? h.reduce((a, b) => a + b, 0) / h.length : (AVG_JOB[k] ?? 60);
      };
      const perBook: Record<string, number> = {};
      for (const j of s.jobs) {
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
    /** Say a request failed, and change nothing. The list stays what the server last said it was. */
    _failed(what: string, cause: unknown): void {
      const uiStore = useUiStore();
      const api = cause instanceof ApiError ? cause : null;
      uiStore.toast(api ? api.message : `Could not ${what}`, {
        kind: "error",
        description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
        timeout: 8000,
      });
    },
    /** A book's spending as the server's ledger sums it. What `useBookSpend` installs. */
    _installSpend(bookId: string, spend: BookSpend): void {
      this.spend[bookId] = spend;
    },
    /** The queue as the server holds it, in place of what was here. What `useBookJobs` installs. */
    _install(jobs: Job[]): void {
      this.jobs = jobs;
    },
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
      for (const j of pending) this.cancelJob(j.id);
      return pending.length;
    },
    /**
     * Try the chapters of one run that failed, and only those — as one run again, so the retry has
     * a run of its own to watch and cancel rather than becoming N unrelated single-chapter runs.
     * The scope is the narrowest one that covers the failure, so nothing that succeeded is redone.
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
      if (kind === "scripting") void scriptingStore.runScripting(bookId, ids, { quiet: true });
      else if (kind === "narration")
        void narrationStore.runNarration(bookId, ids, { scope: "failed", quiet: true });
      else for (const j of failed) this.retryJob(j.id);
      return failed.length;
    },
    removeJob(id: number): void {
      const j = this.jobs.find((j) => j.id === id);
      if (!j || !(j.finishedAt || j.status === "queued")) return;
      const svc = jobsService();
      // a queued job is cancelled first, which settles it, and then it can go
      void (j.status === "queued" ? svc.cancel(id) : Promise.resolve())
        .then(() => svc.remove(id))
        .catch((cause: unknown) => this._failed("remove this job", cause))
        // the cancel may have gone through even when the remove did not
        .finally(() => this._changed());
    },
    cancelJob(id: number): void {
      const job = this.jobs.find((j) => j.id === id);
      if (!job || job.finishedAt || job.cancelled) return;
      // The server's job, so the server stops it: what comes back is the job as it now stands, and
      // the chapter it was for is read again with it. Nothing is marked locally first — a cancel
      // that failed to reach the server must not look like one that worked.
      void jobsService()
        .cancel(id)
        .then(() => this._changed())
        .catch((cause: unknown) => this._failed("cancel this job", cause));
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
      if (job.kind === "scripting")
        void scriptingStore.runScripting(job.bookId, [job.chapterId], { quiet: true });
      if (job.kind === "narration") {
        const c = libraryStore.chapter(job.bookId, job.chapterId);
        if (!c) return;
        // A retry renders what failed, never what already worked. A replacement that failed counts
        // as a failure even though the chapter still reads as narrated — its own clip was never
        // touched — so the failures are looked for on the clips, not on the chapter's status.
        const failed = scriptsStore.segmentsOf(job.bookId, c.id).some(segmentFailed);
        void narrationStore.runNarration(job.bookId, [c.id], {
          scope: failed ? "failed" : "fill",
          quiet: true,
        });
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
        .catch((cause: unknown) => this._failed("clear the history", cause));
    },
    cancelAll(): void {
      for (const j of this.jobs.filter((j) => j.status === "queued")) this.cancelJob(j.id);
      for (const j of this.jobs.filter((j) => j.status === "running")) this.cancelJob(j.id);
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
        if (j.kind === "scripting" && !["queued", "running"].includes(c.scripting)) out.push(j);
        if (
          j.kind === "narration" &&
          scriptsStore.segmentsOf(j.bookId, c.id).some(segmentFailed) &&
          !["queued", "running"].includes(c.narration)
        )
          out.push(j);
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
