// Shared queue and accounting across books and stages. IDs are scoped to this Pinia instance.
import { usable } from "@/lib/exports";
import { logJob } from "@/lib/jobActivity";
import { chapterNarration } from "@/lib/runPlan";
import { makeJobHistory } from "@/mock";
import type {
  EndpointLoad,
  Eta,
  Job,
  JobKind,
  JobStatus,
  ScriptEndpointTelemetry,
  ScriptUsageRecord,
} from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUsageStore } from "@/stores/usage";
const AVG_JOB: Record<JobKind, number> = { scripting: 25, narration: 60, export: 120 };

interface JobsState {
  jobs: Job[];
  scriptTelemetry: Record<string, ScriptEndpointTelemetry>;
  _nextId: number;
  /** ids for bulk runs: every chapter asked for in one press shares one */
  _nextRun: number;
}
export const useJobsStore = defineStore("jobs", {
  state: (): JobsState => {
    let nextId = 100;
    const jobs = makeJobHistory(() => nextId++);
    return { jobs, _nextId: nextId, _nextRun: 1, scriptTelemetry: {} };
  },
  getters: {
    activeJobs(s): Job[] {
      return s.jobs.filter((j) => j.status === "running" || j.status === "queued");
    },
    endpointLoad(): Record<string, EndpointLoad> {
      const endpointsStore = useEndpointsStore();
      const scriptsStore = useScriptsStore();

      const load: Record<string, EndpointLoad> = Object.fromEntries(
        endpointsStore.endpoints.map((e) => [
          e.id,
          { active: 0, done: 0, failed: 0, backoff: e.backoffUntil > Date.now() },
        ]),
      );
      for (const segs of Object.values(scriptsStore.segments))
        for (const seg of segs) {
          const l = seg.audio.endpoint ? load[seg.audio.endpoint] : undefined;
          if (!l) continue;
          if (seg.audio.status === "generating") l.active++;
          else if (seg.audio.status === "done") l.done++;
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
    /**
     * Every scripting request this session settled, each with the receipt it was priced from.
     * It lives in the usage ledger, which is append-only and never re-priced: that is what makes
     * "editing a rate today does not move yesterday's spending" true rather than merely claimed.
     */
    scriptUsage(): ScriptUsageRecord[] {
      return useUsageStore().scriptUsage;
    },
    scriptSpent(): (bookId: string) => number {
      const usageStore = useUsageStore();
      return (bookId: string): number => usageStore.scriptSpent(bookId);
    },
    scriptReserved(s): (bookId: string) => number {
      return (bookId: string): number =>
        s.jobs
          .filter((j) => j.bookId === bookId && !j.finishedAt)
          .reduce((sum, j) => sum + (j.scriptRun?.reserved ?? 0), 0);
    },
    /**
     * Everything held against this book's cap by work that has not landed yet, of either stage.
     * Two runs that each fit on their own must not both be allowed to start and overshoot together,
     * so a reservation is what stops the second one rather than the first one's spending.
     */
    reserved(s): (bookId: string) => number {
      return (bookId: string): number =>
        s.jobs
          .filter((j) => j.bookId === bookId && !j.finishedAt)
          .reduce(
            (sum, j) => sum + (j.scriptRun?.reserved ?? 0) + (j.narrationRun?.reserved ?? 0),
            0,
          );
    },
    /**
     * How much of the input recent requests on one endpoint actually had cached.
     *
     * Only requests whose provider *reported* cache detail count. A provider that says nothing is
     * left out rather than counted as a run of misses, so an endpoint that never reports returns
     * null and the estimate simply does not offer a cache-adjusted figure.
     */
    observedCache(): (profileId: string) => { hitRate: number; samples: number } | null {
      const usageStore = useUsageStore();
      return (profileId: string) => usageStore.observedCache(profileId);
    },
    /**
     * What this book has cost, of both stages.
     *
     * Read out of the append-only ledger, not off the clips the book is holding now. Totalling the
     * current clip of each line lost every request that had been paid for and then superseded — a
     * failed render, a rejected take, the recording a retake displaced — so accepting a retake made
     * recorded spending *fall* and handed the budget back capacity it had really used. The seeded
     * world's own narration predates the ledger and is added from the clips that carry no receipt;
     * those two sets never overlap. See `useUsageStore`.
     */
    spent(): (bookId: string) => number {
      const usageStore = useUsageStore();
      return (bookId: string): number =>
        usageStore.scriptSpent(bookId) +
        usageStore.speechSpent(bookId) +
        usageStore.openingNarrationSpend(bookId);
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
    // ---------- shared ----------
    addJob(kind: JobKind, bookId: string, label: string, chapterId: number | null = null): Job {
      this.jobs.push({
        id: this._nextId++,
        kind,
        bookId,
        chapterId,
        label,
        status: "queued",
        progress: 0,
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        cancelled: false,
      });
      const job = this.jobs[this.jobs.length - 1]; // mutate the reactive proxy
      logJob(job, "Job queued");
      return job;
    },
    /** The id every chapter of one bulk run is tagged with. */
    _nextRunId(): number {
      return this._nextRun++;
    },
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
      if (kind === "scripting") scriptingStore.runScripting(bookId, ids, { quiet: true });
      else if (kind === "narration")
        narrationStore.runNarration(bookId, ids, { scope: "failed", quiet: true });
      else for (const j of failed) this.retryJob(j.id);
      return failed.length;
    },
    removeJob(id: number): void {
      const j = this.jobs.find((j) => j.id === id);
      if (j && (j.finishedAt || j.status === "queued")) {
        if (j.status === "queued") this.cancelJob(id);
        this.jobs = this.jobs.filter((x) => x.id !== id);
      }
    },
    _sequential(jobs: Job[], start: (job: Job, next: () => void) => void): void {
      const next = () => {
        const j = jobs.shift();
        if (!j) return;
        if (j.status === "cancelled") return next();
        start(j, next);
      };
      next();
    },
    _finish(job: Job, status: JobStatus): void {
      if (job.finishedAt !== null) return;
      job.status = status;
      job.finishedAt = Date.now();
      job.waitingReason = "";
      logJob(job, `Job ${status}`, status === "failed" ? "error" : "info", {
        elapsedMs: job.startedAt === null ? 0 : job.finishedAt - job.startedAt,
      });
    },
    cancelJob(id: number): void {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      const job = this.jobs.find((j) => j.id === id);
      if (!job || job.finishedAt || job.cancelled) return;
      job.cancelled = true;
      logJob(job, "Cancellation requested", "warning", {
        behavior:
          job.kind === "narration"
            ? "In-flight clips finish; queued clips will not start"
            : "Stops on the next scheduler tick",
      });
      const c = job.chapterId ? libraryStore.chapter(job.bookId, job.chapterId) : null;
      if (job.status === "queued") {
        this._finish(job, "cancelled");
        // A chapter that never started keeps what it had: a queued re-script cancelled before it
        // dispatched must leave a finished script reading as finished, not as never scripted.
        if (c && job.kind === "scripting") {
          c.scripting = c.rescript?.was ?? "none";
          c.scriptingProgress = 0;
          delete c.rescript; // and no result of this run may land afterwards
        }
        if (c && job.kind === "narration")
          c.narration = chapterNarration(scriptsStore.segmentsOf(job.bookId, c.id));
      }
      // running jobs notice `cancelled` on their next tick
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
        exportsStore.buildExport(
          job.bookId,
          ids,
          { ...run.settings, useStale: run.settings.useStale || stale },
          { updates: run.updates ?? undefined },
        );
        return;
      }
      if (job.chapterId == null) return;
      if (job.kind === "scripting")
        scriptingStore.runScripting(job.bookId, [job.chapterId], { quiet: true });
      if (job.kind === "narration") {
        const c = libraryStore.chapter(job.bookId, job.chapterId);
        if (!c) return;
        // A retry renders what failed, never what already worked. A replacement that failed counts
        // as a failure even though the chapter still reads as narrated — its own clip was never
        // touched — so the failures are looked for on the clips, not on the chapter's status.
        const failed = scriptsStore
          .segmentsOf(job.bookId, c.id)
          .some((x) => x.audio.status === "failed" || x.candidate?.status === "failed");
        narrationStore.runNarration(job.bookId, [c.id], {
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
      this.jobs = this.jobs.filter((j) => !j.finishedAt);
    },
    cancelAll(): void {
      for (const j of this.jobs.filter((j) => j.status === "queued")) this.cancelJob(j.id);
      for (const j of this.jobs.filter((j) => j.status === "running")) this.cancelJob(j.id);
    },
    retryAllFailed(): void {
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();

      // one retry per chapter, grouped by book so each book's chapters queue in order
      const seen = new Set<string>();
      for (const j of this.jobs.filter((j) => j.status === "failed" && j.kind !== "export")) {
        const key = `${j.kind}:${j.bookId}:${j.chapterId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = j.chapterId == null ? undefined : libraryStore.chapter(j.bookId, j.chapterId);
        if (!c) continue;
        // A re-script that failed puts the chapter's status back to what it was, so "did this
        // chapter end up failed" cannot say whether this job's work is still missing. What can is
        // the queue itself: retry unless the chapter is busy or a later run already did the work.
        if (
          j.kind === "scripting" &&
          !["queued", "running"].includes(c.scripting) &&
          !this._supersededBy(j)
        )
          this.retryJob(j.id);
        // a chapter whose replacements failed still reads as narrated — the book's own clips are
        // fine — so the failed requests are looked for on the clips, not only on the chapter
        if (
          j.kind === "narration" &&
          (c.narration === "failed" ||
            scriptsStore.segmentsOf(j.bookId, c.id).some((s) => s.candidate?.status === "failed"))
        )
          this.retryJob(j.id);
      }
    },
    // ---------- scripting ----------
    scriptingTelemetry(id: string): ScriptEndpointTelemetry {
      return (this.scriptTelemetry[id] ??= {
        completed: 0,
        failures: 0,
        rateLimits: 0,
        backoffUntil: 0,
        lastSuccess: 0,
        history: [],
      });
    },
  },
});
