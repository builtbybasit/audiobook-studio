// Re-apply: a book's clips made to sound the way their lines' effects now say, without asking a
// voice for anything again.
//
// A clip remembers what its effects were (`sound`) and, when it had any, the file the voice made
// (`raw`). Editing an effect, or changing who wears which, leaves clips whose sound is not their
// line's any more (`staleClips`). This job renders each of them again from its raw file through the
// chains its line gets now, as one batch for the runner to spread over its workers, or — for a
// line that now gets none — puts the raw file back as the clip. A clip with effects in it and no
// raw file (an ffmpeg thought clip from before raw files were kept) cannot be made again; it is
// counted and left alone.
//
// Each clip lands as its render ends, in a transaction of its own, so a cancel keeps what was done
// and a failure costs only that clip. A clip lands only where a slot still plays the file the job
// read: a line narrated again, a retake kept or a script written over it while it rendered wins,
// and the render is thrown away. What a landing replaced — the old processed file, never a raw
// one — is removed once the job is over, as are renders that never landed.
//
// One job per book at a time (`activeKey`), for the whole book. The job fails at the end when any
// clip could not be made, as a check by ear does, so a retry redoes only those.
import type { Job } from "@/types";
import { plural } from "@/lib/contents";
import { runnable } from "@/lib/effects";
import { pacingOrDefault, chapterSeconds } from "@/lib/speech";
import type { EffectJob, EffectRunner } from "~/audio/effects";
import { fileName, formatOfFile, type AudioFiles } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import type { Db } from "~/db/client";
import { cannotRedo, staleClips, swapClipFile, type StaleClip } from "~/db/effects";
import * as library from "~/db/library";
import { bumpRevision, readScript } from "~/db/script";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";

const LABEL = "Re-apply effects";

export function effectsHandler(runner: EffectRunner | undefined, files: AudioFiles): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      const { bookId } = job;
      const book = library.getBook(db, bookId);
      if (!book) throw notFound("The book was removed before the effects were re-applied");

      const stale = staleClips(db, bookId);
      const stuck = stale.filter(cannotRedo).length;
      if (stuck)
        ctx.note(
          `${plural(stuck, "clip")} keep their old sound: they were made before the voice's own file was kept`,
          "warning",
          { clips: stuck },
        );
      const todo = stale.filter((c) => !cannotRedo(c));
      if (!todo.length) {
        ctx.note("Nothing to re-apply");
        return;
      }
      const renders = todo.filter((c) => c.want != null);
      if (renders.length && !(await runner?.available()))
        throw new Error(
          "Voice effects cannot run on this machine: they run Pedalboard through uv, which was not found",
        );
      ctx.note("Re-apply started", "info", { clips: todo.length });

      const pacing = pacingOrDefault(book.pacing);
      let landed = 0;
      let skipped = 0;
      let failed = 0;
      /** files a landing replaced, and renders that never landed: removed once the job is over */
      const gone: string[] = [];
      const settled = (): void => ctx.progress(((landed + skipped + failed) / todo.length) * 100);
      const fail = (c: StaleClip, e: unknown): void => {
        failed++;
        ctx.note("A clip could not be re-applied", "warning", {
          line: c.segmentId,
          error: e instanceof Error ? e.message : String(e),
        });
        settled();
      };

      /**
       * Make the file at `url` the clip that played `c.url`, if a slot still plays that, with the
       * chapter re-timed to it and its revision moved, so a client holding the old file cannot
       * write it back. Says whether it landed.
       */
      const land = async (
        c: StaleClip,
        next: { url: string; raw: string | null },
      ): Promise<boolean> => {
        const path = await files.find(next.url, bookId);
        const format = path && formatOfFile(path);
        if (!path || !format) throw new Error("The file is not one this library keeps");
        const { duration, sampleRate } = await probeClip(await Bun.file(path).bytes(), format);
        const at = db.transaction((tx) => {
          const slots = swapClipFile(tx, bookId, c.url, {
            ...next,
            sound: c.want,
            duration,
            sampleRate,
          });
          for (const { chapterId, role } of slots) {
            if (role === "current")
              library.setChapterDuration(
                tx,
                bookId,
                chapterId,
                chapterSeconds(readScript(tx, bookId, chapterId), pacing, book),
              );
            bumpRevision(tx, bookId, chapterId);
          }
          return slots.length;
        });
        if (at) {
          landed++;
          // a clip with a raw file was playing a processed one, which nothing plays now
          if (c.raw) gone.push(fileName(c.url));
        } else skipped++;
        settled();
        return at > 0;
      };

      try {
        // a line that now gets no effect plays the voice's own file again; nothing to render
        for (const c of todo) {
          if (signal.aborted) throw signal.reason;
          if (c.want != null) continue;
          try {
            await land(c, { url: c.raw!, raw: null });
          } catch (e) {
            fail(c, e);
          }
        }

        const jobs: EffectJob[] = [];
        const outs: string[] = [];
        for (const c of renders) {
          // `find` makes a demo clip nobody has played yet
          const input = await files.find(c.raw ?? c.url, bookId);
          const out = await files.fresh(bookId, "wav");
          jobs.push({
            // a file the book does not have fails in the batch as missing
            input: input ?? "",
            output: out.path,
            chains: c.effects.map((e) => runnable(e.chain)),
          });
          outs.push(out.url);
        }
        const landings: Promise<unknown>[] = [];
        const kept = new Set<number>();
        try {
          if (jobs.length)
            await runner!.batch(
              jobs,
              (i, error) => {
                const c = renders[i];
                if (error != null) return fail(c, new Error(error));
                landings.push(
                  land(c, { url: outs[i], raw: c.raw ?? c.url }).then(
                    (ok) => ok && kept.add(i),
                    (e) => fail(c, e),
                  ),
                );
              },
              signal,
            );
        } finally {
          await Promise.all(landings);
          outs.forEach((url, i) => kept.has(i) || gone.push(fileName(url)));
        }
      } finally {
        await files.remove(bookId, gone).catch((e: unknown) => {
          ctx.log.warn({ err: e }, "could not remove the files a re-apply replaced");
        });
      }
      if (signal.aborted) throw signal.reason;

      ctx.note("Re-apply finished", failed ? "warning" : "info", {
        clips: landed,
        ...(skipped ? { skipped } : {}),
        ...(failed ? { failed } : {}),
      });
      if (failed) throw new Error(`${plural(failed, "clip")} could not be re-applied`);
    },
  };
}

/** The book's Re-apply, queued; refused while one is already queued or running for it. */
export function enqueueReapply(db: Db, runner: Pick<Runner, "enqueue">, bookId: string): Job {
  if (!library.getBook(db, bookId)) throw notFound("No such book");
  const { job, created } = runner.enqueue({
    kind: "effects",
    bookId,
    chapterId: null,
    label: LABEL,
  });
  if (!created) throw conflict("This book is already re-applying its effects");
  return job;
}
