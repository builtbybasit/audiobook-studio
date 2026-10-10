// The build job: a selection of narrated chapters in, an audiobook on disk out.
//
// It is the third kind the same runner claims, cancels and recovers, and the first one that is
// about a book rather than a chapter — so its `chapterId` is null, its dedupe key is the book,
// and one book builds one audiobook at a time. That is stricter than the browser's rule, which
// lets two audiobooks of one book build at once; the difference is deliberate, because here a
// build reads every clip the other one might be replacing.
//
// **What goes into the file is decided once, by the planner the page drew with.** `planOf` in
// `src/lib/exports.ts` turns the selection, the volumes and the settings into the files, their
// order, their chapters and their names, and the build lays down exactly that. Nothing here
// re-derives which chapter belongs in which file, because the page has already shown someone the
// answer and a second copy of the rule is how the preview and the file stop agreeing.
//
// **An update is a whole new encode.** Every chapter's clips are read and encoded again, by ffmpeg,
// the only encoder: a span of AAC or MP3 cannot be spliced beside audio encoded in another run.
// What each chapter's audio was is recorded on the export (`state`), which is how the page says a
// version is behind the book.
//
// **The version on disk stays current until the new one lands.** The row goes up as `building`
// straight away, so the Audiobooks tab shows a version arriving; the export it supersedes is only
// marked `replaced` by the write that finishes the new one. A build that fails keeps its row and
// its error for Retry to read, and a cancelled one leaves nothing behind at all — in both cases
// the half-written files go and the audiobook that was already there is untouched.
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
  /** the finished export this build is the next version of, when it is an update */
  updates?: number | null;
}

/** Megabytes, as the page quotes them, from bytes as the disk counts them. */
const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 100) / 100;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * One file's tags. The track number is only said of a file per chapter and the disc only of a
 * file per volume: a set of one, or a single file holding the whole book, has neither to say.
 */
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

/** The plan, with the marks the encoder will really write: none in an MP3. */
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

/**
 * What a chapter's audio is right now: its fingerprint, and the lines that can be heard — a line the
 * book does not read is left out of the stitch, clip or no clip (`heardLines`).
 */
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
 * Queue a build, and put its row up while it waits.
 *
 * Every refusal here is one the page already makes, kept because the page is not the only client:
 * a chapter with no usable audio is a gap in the audiobook, and `reviewOf` — the function that
 * draws the blocker panel — is what is asked, so the server's reasons are the page's reasons.
 * Chapters are never quietly dropped from a build the way they are from a bulk narration run: a
 * selection is a promise about what will be in the file.
 *
 * Only the queue's `enqueue` is asked for, so the demo can put up a build the worker never runs —
 * one that failed before this session began (`demo/live.ts`) — through the same refusals and plan.
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
  // A cover is named by the url it was uploaded to. Anything else — the demo's data URL, another
  // book's image, another library's, a path that is not one — is a cover this library could never
  // find, and is said now rather than as a build that fails once it gets there. Whether the file is
  // still on disk is asked by the build itself, which is when it has to be.
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
  // An update of an audiobook the settings have since renamed is not an update at all; it is the
  // first version of a different one, and saying so beats versioning the wrong thing quietly.
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
    // Both are what was written, so they stay at nothing until something has been.
    size: 0,
    markers,
    createdAt: "",
    // what the selection claims, so a later chapter is behind a whole-book audiobook and not a
    // chosen handful
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
    // the fake speech model costs nothing to reserve, and encoding its files nothing at all
    run: { exportRun: run },
    // In the same transaction as the job row, so there is never a queued build with no version
    // showing, nor a version with no build coming — and so the job knows which version it is
    // making before the worker can claim it. An id written after the enqueue returns is an id the
    // handler can start without, since an enqueue wakes the queue at once.
    onCreated: (tx, id) => {
      exportId = exports.insertBuild(tx, { ...draft, jobId: id }, Date.now());
      setRun(tx, id, { ...run, exportId });
    },
  });
  // Lost the race to another request for this book: the unique index refused the second row.
  if (!created) throw conflict("This book is already building an audiobook");

  return { job, export: exports.getExport(db, exportId)! };
}

// ---------- running one ----------

export function exportHandler({ encoders, files }: ExportPorts, clips: AudioFiles): JobHandler {
  /** The clip's file on disk, from the url its row carries — made first if it is a demo clip not yet made. */
  const clipPath = async (bookId: string, url: string | undefined): Promise<string | null> =>
    url ? clips.ready(bookId, basename(url)) : null;
  const covers = coverFiles(clips);

  async function build(ctx: JobContext, entry: ExportItem): Promise<void> {
    const { job, db, signal } = ctx;
    const run = job.exportRun!;
    const encoder = encoders.for(run.settings);
    const book = library.getBook(db, job.bookId);
    if (!book) throw notFound("The book was removed before the build started");

    // A run that died holding this export — a crash, or a restart — left files nobody will
    // finish. They go before this one writes its own, so a book built three times after two
    // crashes has one audiobook on disk and not three.
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
    // The picture: the one the settings chose, or the EPUB's own. A chosen one that has gone is the
    // build failing — the audiobook asked for was one with that picture on it — while the EPUB's
    // gone missing is a build without one, said out loud.
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
    // The book's details from the page, written into every file. A blank title is the book's own,
    // because a file tagged with no title is listed by its file name.
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
      // Recorded before a byte is written, so a build that dies leaves behind a row that knows
      // which file to clean up rather than an orphan nobody can name.
      exports.setBuildFile(db, entry.id, position, token);

      const plan: EncodeChapter[] = [];
      // One file holds one sample rate — the encoder does not resample — so the first clip that says
      // what rate it is sets the file's, and a line rendered at another is named here, by chapter,
      // rather than by the path of a clip file deep inside the encoder. The rate is the one the
      // narration job read off the file whatever its format, so an MP3 at 44.1 kHz and a WAV at
      // 24 kHz are refused together here, and an Opus clip counts as the 48 kHz it decodes at.
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
          // The silence inside a chapter is the book's pacing, the same gap the reader draws and
          // the player leaves; there is none after the last line.
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
        // what the file measured before it was levelled, which is the figure the Export page
        // cannot know until a build has read the audio
        ...(result.measuredLufs != null
          ? {
              loudness: `${result.measuredLufs.toFixed(1)} LUFS in, levelled to ${run.settings.loudness}`,
            }
          : {}),
      });
    }

    // The last point a cancel can still take the build back. Past it the new version is the
    // audiobook and the one it supersedes is `replaced`; the build returns, and the queue calls
    // it done however late a cancel arrives.
    if (signal.aborted) throw signal.reason;
    db.transaction((tx) => {
      exports.finishBuild(tx, entry.id, written, signatures);
      // Only now. Until this line the version it supersedes is still the audiobook on disk.
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
        // The row is the page's account of what happened, so it learns the reason here rather
        // than from the queue's log. A cancelled build has no reason and no row to put one on.
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
        // A cancelled build leaves nothing behind: there is no half an audiobook, and the version
        // it was going to replace is still the one on disk.
        exports.deleteExport(ctx.db, id);
      } else {
        // Still `building` here means the run never reached its own catch — a recovery that gave
        // up on a job that took the process down with it.
        if (entry.status === "building")
          exports.setBuildStatus(
            ctx.db,
            id,
            "failed",
            "The build stopped before the audiobook was written.",
          );
        exports.clearBuildFiles(ctx.db, id);
      }
      // Nobody is waiting on the disk, and a settle that blocked on it would hold the queue.
      inBackground(files.remove(ctx.job.bookId, tokens), "could not remove a build's files", {
        book: ctx.job.bookId,
        export: id,
      });
    },
  };
}
