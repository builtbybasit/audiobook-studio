// The simulated encoder. Nothing here writes a file: progress, timings, reuse and failure are
// produced in the same shape the narration and scripting runs already use, so the Queue treats a
// build like any other job.
import { jobWaiting, logJob } from "@/lib/jobActivity";
import { clock } from "@/mock/simulators/clock";
import type { SimulatorContext } from "@/mock/simulators/context";
import type { ExportItem, Job } from "@/types";

export interface BuildSimContext extends SimulatorContext {
  chapterTitle(bookId: string, chId: number): string;
  exportById(id: number): ExportItem | undefined;
  /** a cancelled build leaves nothing behind, so its entry goes with it */
  dropExport(id: number): void;
  retryJob(id: number): void;
  retryExport(id: number): void;
  /** take the one-shot "make the next build fail" flag as it fires */
  consumeFailure(): void;
}

/** Walks the plan file by file, chapter by chapter. `failMidway` is the seeded failure path. */
export function runBuild(
  ctx: BuildSimContext,
  entry: ExportItem,
  job: Job,
  encode: number[],
  reuse: number[],
  failMidway: boolean,
): void {
  const run = job.exportRun!;
  const bookId = entry.bookId;
  // reused chapters are copied, not encoded, so they cost a fraction of the work
  const cost = (id: number) => (reuse.includes(id) ? 0.08 : 1);
  const queue = entry.files.flatMap((f, fi) =>
    f.chapterIds.map((id) => ({ id, file: f, fileIndex: fi })),
  );
  const totalWork = queue.reduce((a, x) => a + cost(x.id), 0) || 1;
  // a failure lands part-way through, where a real one would: after some files exist
  const failAt = failMidway ? Math.floor(queue.length * 0.55) : -1;
  // long books would otherwise crawl one chapter per tick; a build should feel like a build,
  // not like a progress bar with 214 steps
  const perTick = Math.max(1, Math.ceil(queue.length / 120));
  let i = 0;
  let work = 0;
  let lastFile = -1;
  let milestone = 0;
  const step = () => {
    // the world this build was planned against is gone: stop without writing to the new one
    if (ctx.stale()) {
      clearInterval(t);
      return;
    }
    if (job.cancelled) {
      clearInterval(t);
      ctx.dropExport(entry.id);
      logJob(job, "Build cancelled — nothing was written", "warning", {
        filesFinished: run.file > 1 ? run.file - 1 : 0,
        previousVersion: entry.replaces ? "left in place" : "none",
      });
      ctx.finishJob(job, "cancelled");
      ctx.toast(`Build of ${entry.filename} cancelled`, {
        kind: "info",
        description: entry.replaces
          ? `Nothing was written. v${entry.version - 1} is untouched and still your current export.`
          : "Nothing was written.",
        timeout: 6000,
        action: { label: "Build it again", run: () => ctx.retryJob(job.id) },
      });
      return;
    }
    if (ctx.paused(bookId)) {
      jobWaiting(job, "Book is paused");
      return;
    }
    jobWaiting(job, "");
    const at = queue[i];
    if (!at) return;
    if (at.fileIndex !== lastFile) {
      lastFile = at.fileIndex;
      run.file = at.fileIndex + 1;
      run.fileName = at.file.name;
      logJob(job, `Writing ${at.file.name}`, "info", {
        file: `${run.file} of ${run.files}`,
        chapters: at.file.chapterIds.length,
      });
    }
    if (i === failAt) {
      clearInterval(t);
      ctx.consumeFailure();
      failBuild(ctx, entry, job, at.file.name, ctx.chapterTitle(bookId, at.id));
      return;
    }
    run.stage = reuse.includes(at.id) ? "Copying" : "Encoding";
    work += cost(at.id);
    i++;
    run.done = i;
    entry.progress = Math.min(99, (work / totalWork) * 100);
    job.progress = entry.progress;
    const reached = Math.floor(entry.progress / 25) * 25;
    if (reached > milestone && reached < 100) {
      milestone = reached;
      logJob(job, `${reached}% — ${i} of ${queue.length} chapters`);
    }
    if (i >= queue.length) {
      clearInterval(t);
      if (entry.markers)
        logJob(job, `Wrote ${entry.markers} chapter marks`, "info", {
          pattern: run.settings.markerPattern,
        });
      entry.progress = 100;
      job.progress = 100;
      entry.status = "done";
      entry.size = entry.files.reduce((a, f) => a + f.size, 0);
      run.stage = "Done";
      const prev = entry.replaces ? ctx.exportById(entry.replaces) : null;
      if (prev) prev.status = "replaced";
      logJob(job, "Export ready", "info", {
        files: entry.files.length,
        sizeMB: entry.size,
        audioSeconds: Math.round(entry.duration),
        reusedChapters: reuse.length,
        encodedChapters: encode.length,
      });
      ctx.finishJob(job, "done");
      ctx.toast(`${entry.filename} is ready`, {
        kind: "success",
        description: `v${entry.version} · ${entry.files.length} file${entry.files.length === 1 ? "" : "s"} · ${entry.chapters} chapters${reuse.length ? ` · ${reuse.length} reused` : ""}`,
        timeout: 6000,
      });
    }
  };
  const t = setInterval(() => {
    // `step` clears this interval when the build lands, but a job settled from outside — a demo
    // reset abandoning it, a cancellation elsewhere — never reaches `step` at all, so the timer is
    // dropped here rather than left ticking against a build nothing is watching
    if (ctx.stale() || job.finishedAt) {
      clearInterval(t);
      return;
    }
    for (let n = 0; n < perTick * clock.speed && !job.finishedAt; n++) step();
  }, 140);
}

/** A build that fell over. The version that was already good stays the current one. */
export function failBuild(
  ctx: BuildSimContext,
  entry: ExportItem,
  job: Job,
  file: string,
  chapter: string,
): void {
  entry.status = "failed";
  entry.error = `Encoding stopped while writing ${file}${chapter ? ` at “${chapter}”` : ""}.`;
  logJob(job, `Encoder failed while writing ${file}`, "error", {
    chapter,
    code: "ENC_WRITE",
    detail: "simulated failure",
    previousVersion: entry.replaces ? "still the current export" : "none",
  });
  ctx.finishJob(job, "failed");
  ctx.toast(`${entry.filename} failed to build`, {
    kind: "error",
    description: entry.replaces
      ? `v${entry.version - 1} is untouched and still your current export. Retry from Export or the Queue.`
      : "Nothing was written. Retry from Export or the Queue.",
    timeout: 0,
    action: { label: "Retry", run: () => ctx.retryExport(entry.id) },
  });
}
