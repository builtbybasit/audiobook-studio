// `trim-silence`: trims the clips made before trimming came in, once. Safe while the server runs
// (each clip lands in its own transaction, only where a row still names the file) and to re-run.
// A check by ear's word times move with the cut, so the Listen page stays in step.
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import type { ExpressionAnnotation } from "@/types";
import { chapterSeconds, pacingOrDefault } from "@/lib/speech";
import { audioFiles, fileName, formatOfFile, type AudioFiles } from "~/audio/files";
import { probeClip } from "~/audio/probe";

const seconds = async (wav: Uint8Array) => (await probeClip(wav, "wav")).duration;
import { edgePauses, ffmpegTrim, trimClip, type Edges, type TrimSilence } from "~/audio/trim";
import { openDb, type Db } from "~/db/client";
import * as library from "~/db/library";
import { clips, heard, keptSounds, segments } from "~/db/schema";
import { bumpRevision, readScript } from "~/db/script";
import { env } from "~/env";

export interface Trimmed {
  clips: number;
  failed: number;
}

/**
 * The file trimmed under a new name, or null when there was nothing to cut. `lead`, how far the
 * words moved, costs another ffmpeg run, so only when asked.
 */
async function trimFile(
  files: AudioFiles,
  trim: TrimSilence,
  bookId: string,
  url: string,
  keep: Edges,
  withLead: boolean,
  signal: AbortSignal,
): Promise<{ url: string; duration: number; lead: number } | null> {
  const path = await files.find(url, bookId);
  const format = path && formatOfFile(path);
  if (!path || !format) throw new Error(`${url} is not a file this library keeps`);
  const bytes = await Bun.file(path).bytes();
  const { duration } = await probeClip(bytes, format);
  const cut = await trimClip(trim, { bytes, format, duration }, keep, signal);
  if (!cut) return null;
  const lead = withLead
    ? duration - (await seconds(await trim(bytes, { start: keep.start, end: duration }, signal)))
    : 0;
  const { url: trimmed } = await files.write(bookId, cut.bytes, "wav");
  return { url: trimmed, duration: cut.duration, lead };
}

export async function trimStored(
  db: Db,
  files: AudioFiles,
  trim: TrimSilence,
  log: (line: string) => void = () => {},
  signal: AbortSignal = new AbortController().signal,
): Promise<Trimmed> {
  const rows = db
    .selectDistinct({
      bookId: clips.bookId,
      chapterId: clips.chapterId,
      url: clips.url,
      raw: clips.raw,
      text: segments.text,
      expressions: segments.expressions,
    })
    .from(clips)
    .innerJoin(
      segments,
      and(
        eq(segments.bookId, clips.bookId),
        eq(segments.chapterId, clips.chapterId),
        eq(segments.id, clips.segmentId),
      ),
    )
    .where(and(isNotNull(clips.url), inArray(clips.status, ["done", "stale"])))
    .all();
  const pacing = new Map<string, ReturnType<typeof pacingOrDefault>>();
  const done: Trimmed = { clips: 0, failed: 0 };
  const unused: [string, string][] = [];

  for (const [i, r] of rows.entries()) {
    if (signal.aborted) throw signal.reason;
    const { bookId, chapterId } = r;
    const url = r.url!;
    if (!pacing.has(bookId))
      pacing.set(bookId, pacingOrDefault(library.getBook(db, bookId)?.pacing));
    const keep = edgePauses(
      {
        text: r.text,
        expressions: (r.expressions ?? undefined) as ExpressionAnnotation[] | undefined,
      },
      pacing.get(bookId)!,
    );
    try {
      const wasHeard = db
        .select({ file: heard.file })
        .from(heard)
        .where(and(eq(heard.bookId, bookId), eq(heard.file, fileName(url))))
        .get();
      const next = await trimFile(files, trim, bookId, url, keep, !!wasHeard, signal);
      const raw = r.raw && (await trimFile(files, trim, bookId, r.raw, keep, false, signal));
      if (!next && !raw) continue;
      const landed = db.transaction((tx) => {
        const set = {
          ...(next && { url: next.url, duration: next.duration }),
          ...(raw && { raw: raw.url }),
        };
        const moved = tx
          .update(clips)
          .set(set)
          .where(and(eq(clips.bookId, bookId), eq(clips.url, url)))
          .returning({ id: clips.id })
          .all();
        if (!moved.length) return false;
        if (next) {
          tx.update(keptSounds)
            .set({ url: next.url })
            .where(and(eq(keptSounds.bookId, bookId), eq(keptSounds.url, url)))
            .run();
          const at = and(eq(heard.bookId, bookId), eq(heard.file, fileName(url)));
          const was = tx.select({ words: heard.words }).from(heard).where(at).get();
          if (was)
            tx.update(heard)
              .set({
                file: fileName(next.url),
                words: was.words?.map(([from, to, start, end]) => [
                  from,
                  to,
                  Math.max(0, start - next.lead),
                  Math.max(0, end - next.lead),
                ]),
              })
              .where(at)
              .run();
        }
        const book = library.getBook(tx, bookId);
        library.setChapterDuration(
          tx,
          bookId,
          chapterId,
          chapterSeconds(readScript(tx, bookId, chapterId), pacing.get(bookId)!, book),
        );
        bumpRevision(tx, bookId, chapterId);
        return true;
      });
      if (!landed) {
        // re-narrated while it was trimmed: the new files are nobody's
        for (const f of [next, raw]) if (f) unused.push([bookId, fileName(f.url)]);
        continue;
      }
      done.clips++;
      if (next) unused.push([bookId, fileName(url)]);
      if (raw) unused.push([bookId, fileName(r.raw!)]);
    } catch (e) {
      if (signal.aborted) throw e;
      done.failed++;
      log(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((i + 1) % 100 === 0) log(`${i + 1} of ${rows.length} clips looked at`);
  }

  // a take or a kept sound may still name an old file
  for (const [bookId, file] of unused) {
    const url = `${files.base}/audio/${bookId}/${file}`;
    const named = db
      .select({ id: clips.id })
      .from(clips)
      .where(and(eq(clips.bookId, bookId), or(eq(clips.url, url), eq(clips.raw, url))))
      .get();
    if (!named) await files.remove(bookId, [file]);
  }
  return done;
}

if (import.meta.main) {
  const done = await trimStored(
    openDb(),
    audioFiles(env.AUDIO_DIR),
    ffmpegTrim(env.FFMPEG_BIN),
    console.log,
  );
  console.log(`${done.clips} clips trimmed${done.failed ? `, ${done.failed} could not be` : ""}`);
  if (done.failed) process.exitCode = 1;
}
