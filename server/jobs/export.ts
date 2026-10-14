// The build job: narrated chapters in, an audiobook on disk out. One build per book at a time
// (`chapterId` null). The file layout comes from `planOf` in src/lib/exports.ts, the same planner
// the page previews with, so nothing here re-derives it. An update is a full re-encode (AAC/MP3
// can't be spliced). The previous version stays current until the new one lands.
import { basename } from "node:path";

import type {
  Book,
  BuildQueued,
  Chapter,
  ExportFile,
  ExportItem,
  ExportSettings,
  Job,
  Pacing,
  Segment,
  Volume,
} from "@/types";
import {
  chapterSignature,
  exportKey,
  fileTitle,
  markerTitle,
  planOf,
  reviewOf,
  scopeOf,
  setLabel,
} from "@/lib/exports";
import { heardLines } from "@/lib/siteText";
import { pacingOrDefault, pauseAfter, sampleRateLabel } from "@/lib/speech";
import type { AudioFiles } from "~/audio/files";
import { coverFiles, type CoverFiles } from "~/covers/files";
import type { Db, Tx } from "~/db/client";
import * as exports from "~/db/exports";
import { activeJob, getJob, setRun } from "~/db/jobs";
import * as library from "~/db/library";
import { readScript } from "~/db/script";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { badRequest, conflict, notFound } from "~/lib/errors";
import type {
  AudiobookEncoder,
  EncodeChapter,
  EncodePart,
  EncodeTags,
  ExportPorts,
} from "~/providers/encoder";
import { inBackground } from "~/lib/background";

export interface BuildInput {
  ids: readonly number[];
  settings: ExportSettings;
  /** the export this build updates, if any */
  updates?: number | null;
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 100) / 100;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** One file's tags. Track number only for per-chapter files, disc only for per-volume files. */
function tagsOf(
  s: ExportSettings,
  file: ExportFile,
  position: number,
  count: number,
  known: Map<number, Chapter>,
): EncodeTags {
  const chapters = file.chapterIds.flatMap((id) => known.get(id) ?? []);
  return {
    title: fileTitle(s, s.grouping === "volume" ? (file.volume?.name ?? null) : null, chapters),
    book: s.title,
    author: s.author,
    narrator: s.narrator,
    series: s.series,
    year: s.year,
    description: s.description,
    track: s.grouping === "chapter" && count > 1 ? { n: position + 1, of: count } : undefined,
    disc: file.volume && count > 1 ? { n: file.volume.number, of: file.volume.of } : undefined,
  };
}

/** The plan, with the chapter marks the encoder really writes (none in MP3). */
function planFor(
  chapters: Chapter[],
  volumes: Volume[],
  settings: ExportSettings,
  encoder: AudiobookEncoder,
): { files: ExportFile[]; label: string; markers: number } {
  const files: ExportFile[] = planOf({ chapters, volumes, settings }).files.map((f) => ({
    name: f.name,
    chapterIds: f.chapterIds,
    duration: f.duration,
    size: f.size,
    markers: encoder.markers ? f.markers : 0,
    volume: f.volume,
  }));
  return {
    files,
    label: setLabel(settings, files),
    markers: files.reduce((a, f) => a + f.markers, 0),
  };
}

/** A chapter's audio fingerprint and its heard lines; unread lines are left out (`heardLines`). */
function audioOf(
  db: Db | Tx,
  book: Book,
  chapter: Chapter,
  pacing: Pacing,
): { signature: string; lines: Segment[] } {
  const segments = readScript(db, book.id, chapter.id);
  return {
    signature: chapterSignature(chapter, segments, pacing, book),
    lines: heardLines(segments, book),
  };
}

// ---------- queueing one ----------

/**
 * Queue a build and put its row up. Refusals come from `reviewOf`, the page's blocker panel, so
 * both give the same reasons. Unlike narration, chapters are never silently dropped. Takes only
 * `enqueue` so the demo (`demo/live.ts`) can stage a build the worker never runs.
 */
export function enqueueBuild(
  db: Db,
  runner: Pick<Runner, "enqueue">,
  { encoders }: ExportPorts,
  covers: CoverFiles,
  bookId: string,
  { ids, settings, updates = null }: BuildInput,
): BuildQueued {
  const encoder = encoders.for(settings);
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (book.importing) throw conflict("Finish the contents review before building this book");
  // Only this book's uploaded cover URLs resolve; refuse anything else now rather than mid-build.
  // Whether the file still exists is checked by the build.
  if (settings.cover != null && !covers.fileOf(bookId, settings.cover))
    throw badRequest(
      "The cover image is not one this server holds; choose it again",
      "A cover is uploaded to the book first, and the build names it by the address it was given.",
    );

  const known = new Map(library.listChapters(db, bookId).map((c) => [c.id, c]));
  const absent = [...new Set(ids)].filter((id) => !known.has(id));
  if (absent.length)
    throw badRequest(
      absent.length === 1
        ? "The selection names a chapter this book does not have"
        : `The selection names ${absent.length} chapters this book does not have`,
      "The selection names chapters that are not in the book any more. Read the book again and build from what is there.",
    );
  const chapters = [...new Set(ids)].sort((a, b) => a - b).map((id) => known.get(id)!);
  if (!chapters.length) throw badRequest("Choose at least one chapter to build");

  const blocker = reviewOf(chapters, settings).blockers[0];
  if (blocker) throw conflict(blocker.title, blocker.detail);

  if (activeJob(db, "export", bookId, null))
    throw conflict(
      "This book is already building an audiobook",
      "One build at a time per book: a second would be reading the same clips as the first. Wait for it, or cancel it from the Queue.",
    );

  const key = exportKey(settings);
  const named = updates == null ? null : exports.getExport(db, updates);
  if (updates != null && (!named || named.bookId !== bookId))
    throw notFound("No such export to update");
  // a renamed audiobook is a different one, not an update
  const prev =
    named?.key === key
      ? named
      : (exports
          .listExports(db, bookId)
          .filter((e) => e.key === key && e.status === "done")
          .at(-1) ?? null);

  const pacing = pacingOrDefault(book.pacing);
  const ordered = chapters.map((c) => c.id);
  const state: Record<number, string> = {};
  for (const c of chapters) state[c.id] = audioOf(db, book, c, pacing).signature;

  const { files, label, markers } = planFor(chapters, book.volumes, settings, encoder);
  const draft: Omit<ExportItem, "id"> = {
    bookId,
    key,
    filename: label,
    title: settings.title,
    series: settings.series,
    author: settings.author,
    narrator: settings.narrator,
    year: settings.year,
    description: settings.description,
    format: settings.format,
    grouping: settings.grouping,
    files,
    chapterIds: ordered,
    chapters: chapters.length,
    duration: round2(files.reduce((a, f) => a + f.duration, 0)),
    bitrate: settings.bitrate,
    chapterGap: settings.chapterGap,
    normalize: settings.normalize,
    loudness: settings.loudness,
    size: 0,
    markers,
    createdAt: "",
    // a chapter added later makes a whole-book audiobook behind, not a chosen handful
    scope: scopeOf([...known.values()], ordered, settings.grouping),
    version: prev ? prev.version + 1 : 1,
    replaces: prev?.id ?? null,
    status: "building",
    progress: 0,
    state,
    settings: { ...settings },
    customCover: !!settings.cover,
    timeline: chapters.map((c) => ({ id: c.id, title: c.title, duration: c.duration })),
    stale: chapters.filter((c) => c.narration === "stale").length,
  };

  const run: NonNullable<Job["exportRun"]> = {
    exportId: 0,
    settings: { ...settings },
    chapterIds: ordered,
    updates: prev?.id ?? null,
    files: files.length,
    file: 0,
    fileName: files[0]?.name ?? label,
    stage: "Preparing",
    done: 0,
  };

  let exportId = 0;
  const { job, created } = runner.enqueue({
    kind: "export",
    bookId,
    chapterId: null,
    label: `Build ${label}`,
    run: { exportRun: run },
    // Same transaction as the job row: the job knows its export id before the worker can claim it.
    onCreated: (tx, id) => {
      exportId = exports.insertBuild(tx, { ...draft, jobId: id }, Date.now());
      setRun(tx, id, { ...run, exportId });
    },
  });
  // lost the race: the unique index refused a second build for this book
  if (!created) throw conflict("This book is already building an audiobook");

  return { job, export: exports.getExport(db, exportId)! };
}

// ---------- running one ----------

export function exportHandler({ encoders, files }: ExportPorts, clips: AudioFiles): JobHandler {
  /** The clip's file on disk; a demo clip is made first if needed. */
  const clipPath = async (bookId: string, url: string | undefined): Promise<string | null> =>
    url ? clips.ready(bookId, basename(url)) : null;
  const covers = coverFiles(clips);

  async function build(ctx: JobContext, entry: ExportItem): Promise<void> {
    const { job, db, signal } = ctx;
    const run = job.exportRun!;
    const encoder = encoders.for(run.settings);
    const book = library.getBook(db, job.bookId);
    if (!book) throw notFound("The book was removed before the build started");

    // remove files a crashed earlier attempt left behind
    const leftover = exports.exportFileTokens(db, entry.id);
    if (leftover.length) {
      await files.remove(job.bookId, leftover);
      exports.clearBuildFiles(db, entry.id);
      ctx.note("Picking up a build that was interrupted", "warning", {
        discarded: leftover.length,
      });
    }

    const pacing = pacingOrDefault(book.pacing);
    const known = new Map(library.listChapters(db, job.bookId).map((c) => [c.id, c]));
    const prev = entry.replaces == null ? null : (exports.getExport(db, entry.replaces) ?? null);

    ctx.note(
      prev ? `Updating ${entry.filename} to v${entry.version}` : `Building ${entry.filename}`,
      "info",
      {
        files: entry.files.length,
        chapters: entry.chapterIds.length,
        format: run.settings.format,
        layout: run.settings.grouping,
        bitrateKbps: run.settings.bitrate,
      },
    );
    // A missing chosen cover fails the build; a missing EPUB cover is a warning and no picture.
    const chosen = run.settings.cover;
    let cover = chosen ? await covers.existing(job.bookId, chosen) : null;
    if (chosen && !cover)
      throw new Error(
        "The cover image this build names is no longer on the server; choose it again",
      );
    if (!chosen && book.coverImage) {
      cover = await covers.existing(job.bookId, book.coverImage);
      if (!cover)
        ctx.note(
          "The EPUB's cover is missing from the server; the file carries none",
          "warning",
          {},
        );
    }
    if (cover)
      ctx.note(chosen ? "Embedding your cover image" : "Embedding the EPUB's cover", "info", {});
    // blank title falls back to the book's: untitled files are listed by file name
    const details = { ...run.settings, title: run.settings.title.trim() || book.title };
    ctx.note("Tagging each file with the book's details", "info", {
      title: details.title,
      author: details.author.trim() || "none",
      narrator: details.narrator.trim() || "none",
    });
    if (entry.stale)
      ctx.note(`${entry.stale} chapters use clips the script has moved under`, "warning", {
        accepted: "the build was started with “use stale audio”",
      });
    if (run.settings.normalize && encoder.normalizes)
      ctx.note(`Loudness normalisation to ${run.settings.loudness} LUFS`, "info", {
        measured: "EBU R128, in two passes over the joined audio",
      });

    const written: exports.WrittenFile[] = [];
    const signatures = new Map<number, string>();
    let done = 0;

    const tick = (stage: string, file: number, fileName: string): void => {
      const pct = Math.round((done / Math.max(1, entry.chapterIds.length)) * 100);
      ctx.progress(pct);
      exports.setBuildProgress(db, entry.id, Math.min(99, pct));
      setRun(db, job.id, { ...run, stage, file, fileName, done });
    };

    for (const [position, file] of entry.files.entries()) {
      if (signal.aborted) throw signal.reason;
      ctx.note(`Writing ${file.name}`, "info", {
        file: `${position + 1} of ${entry.files.length}`,
        chapters: file.chapterIds.length,
      });
      const { token, path } = await files.reserve(job.bookId, encoder.ext);
      // recorded before writing, so a crash leaves a row that knows what to clean up
      exports.setBuildFile(db, entry.id, position, token);

      const plan: EncodeChapter[] = [];
      // One sample rate per file (the encoder doesn't resample): the first clip sets it, and a
      // mismatch is reported here by chapter and line. Opus counts as 48 kHz.
      let rate: { hz: number; chapter: string } | null = null;
      for (const id of file.chapterIds) {
        const chapter = known.get(id);
        if (!chapter)
          throw notFound(`A chapter was removed while ${entry.filename} was being built`);
        const { signature, lines } = audioOf(db, book, chapter, pacing);
        signatures.set(id, signature);
        const title = markerTitle(
          chapter,
          plan.length + 1,
          run.settings,
          file.volume?.name ?? null,
        );
        const parts: EncodePart[] = [];
        for (const [i, s] of lines.entries()) {
          const at = await clipPath(job.bookId, s.audio.url);
          if (!at)
            throw new Error(
              `“${chapter.title}” has a line whose audio is not a file on this server; narrate it again`,
            );
          parts.push({ kind: "clip", path: at });
          const hz = s.audio.sampleRate;
          if (hz != null && !rate) rate = { hz, chapter: chapter.title };
          else if (hz != null && rate && hz !== rate.hz)
            throw new Error(
              `“${chapter.title}” has a line rendered at ${sampleRateLabel(hz)}, and ${file.name} already holds ${sampleRateLabel(rate.hz)} audio from “${rate.chapter}”; narrate it again at one rate`,
            );
          // the book's pacing gap, none after the last line
          const pause = pauseAfter(s, lines[i + 1], pacing);
          if (pause > 0) parts.push({ kind: "silence", seconds: pause });
        }
        plan.push({ id, title, parts });
      }

      tick("Encoding", position + 1, file.name);
      const result = await encoder.encode({
        chapters: plan,
        gap: run.settings.chapterGap,
        out: path,
        signal,
        cover,
        tags: tagsOf(details, file, position, entry.files.length, known),
        onChapter: () => {
          done++;
          tick("Encoding", position + 1, file.name);
        },
      });
      written.push({
        position,
        token,
        duration: round2(result.seconds),
        size: mb(result.bytes),
        chapters: result.chapters.map((c) => ({ id: c.id, seconds: round2(c.seconds) })),
      });
      ctx.note(`${file.name} is written`, "info", {
        seconds: Math.round(result.seconds),
        sizeMB: mb(result.bytes),
        // pre-normalisation loudness, which the Export page can't know until a build
        ...(result.measuredLufs != null
          ? {
              loudness: `${result.measuredLufs.toFixed(1)} LUFS in, levelled to ${run.settings.loudness}`,
            }
          : {}),
      });
    }

    // Last point a cancel can take the build back; past it the build counts as done.
    if (signal.aborted) throw signal.reason;
    db.transaction((tx) => {
      exports.finishBuild(tx, entry.id, written, signatures);
      if (entry.replaces != null) exports.setBuildStatus(tx, entry.replaces, "replaced");
    });
    setRun(db, job.id, {
      ...run,
      stage: "Done",
      file: entry.files.length,
      fileName: entry.files.at(-1)?.name ?? entry.filename,
      done,
    });
    const finished = exports.getExport(db, entry.id)!;
    ctx.note("Export ready", "info", {
      files: written.length,
      sizeMB: finished.size,
      audioSeconds: Math.round(finished.duration),
      chapters: entry.chapterIds.length,
    });
  }

  return {
    async run(ctx: JobContext): Promise<void> {
      const run = ctx.job.exportRun;
      if (!run) throw new Error("A build job carries what it is building");
      const entry = exports.getExport(ctx.db, run.exportId);
      if (!entry) throw notFound("The audiobook this build was making has been forgotten");
      try {
        await build(ctx, entry);
      } catch (e) {
        // the page reads the reason from the row, not the job log
        if (!ctx.signal.aborted)
          exports.setBuildStatus(
            ctx.db,
            entry.id,
            "failed",
            e instanceof Error ? e.message : String(e),
          );
        throw e;
      }
    },

    onSettled(ctx, status): void {
      if (status === "done") return;
      const fresh = getJob(ctx.db, ctx.job.id);
      const id = fresh?.exportRun?.exportId ?? ctx.job.exportRun?.exportId;
      if (!id) return;
      const entry = exports.getExport(ctx.db, id);
      if (!entry) return;
      const tokens = exports.exportFileTokens(ctx.db, id);
      if (status === "cancelled") {
        exports.deleteExport(ctx.db, id);
      } else {
        // still `building`: the process died before the run's own catch
        if (entry.status === "building")
          exports.setBuildStatus(
            ctx.db,
            id,
            "failed",
            "The build stopped before the audiobook was written.",
          );
        exports.clearBuildFiles(ctx.db, id);
      }
      // don't hold the queue on disk cleanup
      inBackground(files.remove(ctx.job.bookId, tokens), "could not remove a build's files", {
        book: ctx.job.bookId,
        export: id,
      });
    },
  };
}
