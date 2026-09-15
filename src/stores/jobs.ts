// Shared queue and accounting across books and stages. IDs are scoped to this Pinia instance.
import { usable } from "@/lib/exports";
import { logJob } from "@/lib/jobActivity";
import { makeJobHistory } from "@/mock";
import type { EndpointLoad, Eta, Job, JobKind, JobStatus, ScriptEndpointTelemetry } from "@/types";
import { defineStore } from "pinia";
import { useEndpointsStore } from "./endpoints";
import { useExportsStore } from "./exports";
import { useLibraryStore } from "./library";
import { useNarrationStore } from "./narration";
import { useScriptingStore } from "./scripting";
import { useScriptsStore } from "./scripts";
const AVG_JOB: Record<JobKind, number> = { scripting: 25, narration: 60, export: 120 };

interface JobsState {
  jobs: Job[];
  scriptUsage: {
    bookId: string;
    profileId: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  scriptTelemetry: Record<string, ScriptEndpointTelemetry>;
  _nextId: number;
}
export const useJobsStore = defineStore("jobs", {
  state: (): JobsState => {
    let nextId = 100;
    const jobs = makeJobHistory(() => nextId++);
    return { jobs, _nextId: nextId, scriptUsage: [], scriptTelemetry: {} };
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
    recentJobs(s): Job[] {
      return [...s.jobs].reverse().slice(0, 12);
    },
    scriptSpent(s): (bookId: string) => number {
      return (bookId: string): number =>
        s.scriptUsage.filter((x) => x.bookId === bookId).reduce((sum, x) => sum + x.cost, 0);
    },
    scriptReserved(s): (bookId: string) => number {
      return (bookId: string): number =>
        s.jobs
          .filter((j) => j.bookId === bookId && !j.finishedAt)
          .reduce((sum, j) => sum + (j.scriptRun?.reserved ?? 0), 0);
    },
    spent(s): (bookId: string) => number {
      const scriptsStore = useScriptsStore();
      return (bookId: string): number => {
        let t = s.scriptUsage
          .filter((x) => x.bookId === bookId)
          .reduce((sum, x) => sum + x.cost, 0);
        for (const [k, segs] of Object.entries(scriptsStore.segments))
          if (k.startsWith(bookId + ":"))
            for (const x of segs)
              if (x.audio.cost && x.audio.status !== "failed") t += x.audio.cost;
        return t;
      };
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
        if (c && job.kind === "scripting") c.scripting = "none";
        if (c && job.kind === "narration") c.narration = c.duration ? "done" : "none";
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
      if (job.kind === "scripting") scriptingStore.runScripting(job.bookId, [job.chapterId]);
      if (job.kind === "narration") {
        const c = libraryStore.chapter(job.bookId, job.chapterId);
        if (!c) return;
        if (
          c.narration === "failed" &&
          scriptsStore.segmentsOf(job.bookId, c.id).some((x) => x.audio.status === "done")
        )
          narrationStore.retryFailed(job.bookId, c.id);
        else narrationStore.runNarration(job.bookId, [c.id]);
      }
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

      // one retry per chapter, grouped by book so each book's chapters queue in order
      const seen = new Set<string>();
      for (const j of this.jobs.filter((j) => j.status === "failed" && j.kind !== "export")) {
        const key = `${j.kind}:${j.bookId}:${j.chapterId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = j.chapterId == null ? undefined : libraryStore.chapter(j.bookId, j.chapterId);
        if (!c) continue;
        if (j.kind === "scripting" && c.scripting === "failed") this.retryJob(j.id);
        if (j.kind === "narration" && c.narration === "failed") this.retryJob(j.id);
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
