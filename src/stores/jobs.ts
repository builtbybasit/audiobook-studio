// Shared queue and accounting across books and stages. IDs are scoped to this Pinia instance.
//
// This store is the queue's side of the seam in `@/services/jobs`. With a service answering, the
// jobs are the server's: the list is read from it, a cancel is a request, and the store polls
// while anything is live so the Queue page moves. Without one, the seeded queue in the store is
// the queue, and the simulators drive it. The halves are here rather than in the views.
import { usable } from "@/lib/exports";
import { logJob } from "@/lib/jobActivity";
import { chapterNarration, segmentFailed } from "@/lib/runPlan";
import { makeJobHistory } from "@/mock";
import { ApiError } from "@/services/http";
import { activeJobsService, type JobsService } from "@/services/jobs";
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
import { useUiStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
const AVG_JOB: Record<JobKind, number> = { scripting: 25, narration: 60, export: 120 };

/** How often the server is asked again while something is queued or running. */
export const POLL_MS = 1500;

/** The timers behind `startPolling`, one per store instance, kept out of the reactive state. */
const pollTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

interface JobsState {
  jobs: Job[];
  scriptTelemetry: Record<string, ScriptEndpointTelemetry>;
  _nextId: number;
  /** ids for bulk runs: every chapter asked for in one press shares one */
  _nextRun: number;
  /** Backend mode: whether the queue has been read from the server yet. */
  loaded: boolean;
  /** Backend mode: whether `startPolling` is keeping the list fresh. */
  polling: boolean;
}
export const useJobsStore = defineStore("jobs", {
  // With a service answering, the queue starts empty and is read from the server. The seeded
  // history is not a starting point for a real queue — it is the other mode.
  state: (): JobsState => {
    let nextId = 100;
    const jobs = activeJobsService() ? [] : makeJobHistory(() => nextId++);
    return {
      jobs,
      _nextId: nextId,
      _nextRun: 1,
      scriptTelemetry: {},
      loaded: false,
      polling: false,
    };
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
    // ---------- the seam ----------
    /** The service answering for the queue, or null when this is the seeded demo. */
    _service(): JobsService | null {
      return activeJobsService();
    },
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
    /** Read the queue from the server. Demo mode is already holding one. */
    async load(): Promise<void> {
      const svc = this._service();
      if (!svc || this.loaded) return;
      await this.refresh();
    },
    /**
     * Ask the server again, and bring the rest of the app up to date with what changed.
     *
     * A job that moved is a chapter that moved: its status and progress are the server's, so the
     * book is read again, and a scripting job that finished is a script to read. Both are asked
     * for here rather than left for a view to notice, so the Scripting page and the picker follow
     * the queue without either of them polling.
     */
    async refresh({ quiet = false } = {}): Promise<void> {
      const svc = this._service();
      if (!svc) return;
      const libraryStore = useLibraryStore();
      const scriptsStore = useScriptsStore();
      const before = new Map(this.jobs.map((j) => [j.id, j]));
      // On the first read a job the store has never heard of is history, not change: reading
      // every book and every finished script the server mentions would be a startup fan-out that
      // grows with the history. A job the store *has* heard of — one it queued a moment ago, through
      // `_seen` — is compared like any other, so a run that finished before the first list arrived
      // still brings its script.
      const first = !this.loaded;
      let next: Job[];
      try {
        next = await svc.list();
      } catch (cause) {
        // a poll that finds the server down says so once, not every tick until it is back
        if (!quiet) this._failed("read the queue", cause);
        return;
      }
      this.jobs = next;
      this.loaded = true;

      const books = new Set<string>();
      const scripts: [string, number][] = [];
      for (const j of next) {
        const was = before.get(j.id);
        const moved = was ? was.status !== j.status || was.progress !== j.progress : !first;
        if (!moved || !libraryStore.bookById(j.bookId)) continue;
        books.add(j.bookId);
        // a script is read again only when this job *finished* now — not when a job that was
        // already done is merely seen again, which would replace a script with a copy of itself
        if (
          j.kind === "scripting" &&
          j.status === "done" &&
          was?.status !== "done" &&
          j.chapterId != null
        )
          scripts.push([j.bookId, j.chapterId]);
      }
      await Promise.all([
        ...[...books].map((id) => libraryStore.loadBook(id)),
        ...scripts.map(([b, c]) => scriptsStore.loadScript(b, c, { force: true })),
      ]);
    },
    /**
     * Jobs the server just made for this store, before the next read.
     *
     * What an enqueue answers with is the job as it was at that instant, and the next `refresh`
     * compares against it — which is how a job that finished before that read comes back as a
     * change rather than as history.
     */
    _seen(jobs: Job[]): void {
      const byId = new Map(this.jobs.map((j) => [j.id, j]));
      for (const j of jobs) byId.set(j.id, j);
      this.jobs = [...byId.values()].sort((a, b) => a.id - b.id);
    },
    /**
     * Keep the list fresh while anything is live.
     *
     * Started once at startup in backend mode and after anything is queued; it stops itself when
     * the queue goes quiet and is started again by the next enqueue, so an idle app makes no
     * requests. Demo mode never comes here.
     */
    startPolling(): void {
      if (!this._service() || this.polling) return;
      this.polling = true;
      const tick = async () => {
        pollTimers.delete(this);
        if (!this.polling) return;
        await this.refresh({ quiet: true });
        if (!this.activeJobs.length) {
          this.polling = false;
          return;
        }
        // a chain restarted while this tick was waiting on the server already has a timer
        if (!pollTimers.has(this)) pollTimers.set(this, setTimeout(tick, POLL_MS));
      };
      pollTimers.set(this, setTimeout(tick, POLL_MS));
    },
    stopPolling(): void {
      this.polling = false;
      const t = pollTimers.get(this);
      if (t) clearTimeout(t);
      pollTimers.delete(this);
    },
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
      if (!j || !(j.finishedAt || j.status === "queued")) return;
      const svc = this._service();
      if (svc) {
        // a queued job is cancelled first, which settles it, and then it can go
        void (j.status === "queued" ? svc.cancel(id) : Promise.resolve())
          .then(() => svc.remove(id))
          .catch((cause: unknown) => this._failed("remove this job", cause))
          // the cancel may have gone through even when the remove did not
          .finally(() => this.refresh({ quiet: true }));
        return;
      }
      if (j.status === "queued") this.cancelJob(id);
      this.jobs = this.jobs.filter((x) => x.id !== id);
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
      const svc = this._service();
      if (svc) {
        // The server's job, so the server stops it: what comes back is the job as it now stands,
        // and the chapter it was for is read again with it. Nothing is marked locally first — a
        // cancel that failed to reach the server must not look like one that worked.
        void svc
          .cancel(id)
          .then(() => this.refresh())
          .then(() => this.startPolling())
          .catch((cause: unknown) => this._failed("cancel this job", cause));
        return;
      }
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
        const failed = scriptsStore.segmentsOf(job.bookId, c.id).some(segmentFailed);
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
      const svc = this._service();
      if (svc) {
        void svc
          .clear()
          .then(() => this.refresh())
          .catch((cause: unknown) => this._failed("clear the history", cause));
        return;
      }
      this.jobs = this.jobs.filter((j) => !j.finishedAt);
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
