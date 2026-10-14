// Re-apply: re-renders stale clips (`staleClips`) from their `raw` file through their line's
// current effects, with no new voice request. A clip with effects but no raw can't be redone.
// Each clip lands in its own transaction, only if a slot still plays the file the job read;
// otherwise the newer work wins and the render is discarded.
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
      /** replaced and unlanded files, removed when the job ends */
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

      /** Swap in `url` where a slot still plays `c.url`, moving the revision. True if it landed. */
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
          // the old processed file (never a raw) is now unused
          if (c.raw) gone.push(fileName(c.url));
        } else skipped++;
        settled();
        return at > 0;
      };

      try {
        // lines with no effect now just play their raw file again
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

/** Queue the book's Re-apply; refused while one is active. */
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
