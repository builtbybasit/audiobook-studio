// Voice samples waiting with a speaker: kept from a script file when the import is applied (never
// when planned), read, discarded and restored. A discard hides them; the first read of the book's
// samples after the grace period removes them, so Undo works until then.
import { existsSync } from "node:fs";

import type { KeptSample, ScriptFileVoice, SpeakerSamples, StoredSamples } from "@/types";
import { readCast } from "~/db/cast";
import type { Db } from "~/db/client";
import { getBook } from "~/db/library";
import {
  filesOf,
  keepSpeakerSamples,
  namedFiles,
  purgeDiscardedRows,
  sampleRow,
  setDiscarded,
  toSpeakerSamples,
  waitingSamples,
  type KeepSpeakerSamples,
} from "~/db/speakerSamples";
import { GRACE_MS } from "~/db/voiceSamples";
import { inBackground } from "~/lib/background";
import { fail, notFound } from "~/lib/errors";
import type { SampleFormat } from "~/providers/clone";
import { readScriptFile, type ReadFile, type ScriptUpload } from "~/script/scriptFile";
import { speakerSampleFiles, type SpeakerSampleFiles } from "~/speakerSamples/files";
import {
  folderOf,
  judgeVoiceFolder,
  SAMPLE_LIMITS,
  type JudgedClip,
  type SampleLimits,
} from "~/speakerSamples/folder";

export interface SampleOptions {
  now?: () => number;
  /** the clone route's unless a test lowers them */
  limits?: SampleLimits;
}

// ---------- reading ----------

export interface WaitingVoice {
  speaker: string;
  title: string;
  samples: {
    name: string;
    format: SampleFormat;
    bytes: number;
    read(): Promise<Uint8Array>;
  }[];
}

/** Discarded rows are not carried. */
export function readSpeakerSamplesForExport(
  db: Db,
  bookId: string,
  audioDir: string,
): WaitingVoice[] {
  const disk = speakerSampleFiles(audioDir);
  return waitingSamples(db, bookId)
    .map((w) => ({
      speaker: w.speaker,
      title: w.title,
      // a recording gone from disk is left out rather than failing the export
      samples: w.samples.flatMap((s) => {
        const path = disk.path(bookId, s.file);
        if (!path || !existsSync(path)) return [];
        return [
          { name: s.name, format: s.format, bytes: s.bytes, read: () => Bun.file(path).bytes() },
        ];
      }),
    }))
    .filter((w) => w.samples.length);
}

// ---------- the routes' operations ----------

function requireBook(db: Db, bookId: string): void {
  if (!getBook(db, bookId)) throw notFound("There is no book by that id", `id: ${bookId}`);
}

/** Purges discards past the grace period first: the read is where that happens. */
export function listSamples(
  db: Db,
  files: SpeakerSampleFiles,
  bookId: string,
  { now = Date.now }: SampleOptions = {},
): SpeakerSamples[] {
  requireBook(db, bookId);
  purgeDiscarded(db, files, bookId, now());
  return waitingSamples(db, bookId);
}

export function purgeDiscarded(
  db: Db,
  files: SpeakerSampleFiles,
  bookId: string,
  now: number,
): void {
  const gone = purgeDiscardedRows(db, bookId, now - GRACE_MS);
  if (gone.length)
    inBackground(files.remove(bookId, gone), "could not remove discarded voice samples", {
      book: bookId,
    });
}

/**
 * The apply step of a plan the page showed: a speaker that fails is refused whole. Recordings a
 * speaker already had are discarded, not deleted (`replaced`), for Undo. The file is read twice,
 * heads first, so only the folders asked for are held whole in memory.
 */
export async function storeSamples(
  db: Db,
  files: SpeakerSampleFiles,
  bookId: string,
  upload: ScriptUpload,
  speakers: readonly string[],
  { now = Date.now, limits = SAMPLE_LIMITS }: SampleOptions = {},
): Promise<StoredSamples> {
  requireBook(db, bookId);
  const names = [...new Set(speakers)];
  if (!names.length) fail(400, "Name at least one speaker whose recordings to keep");
  const cast = new Set(readCast(db, bookId).map((c) => c.name));
  const missing = names.filter((n) => !cast.has(n));
  if (missing.length)
    fail(400, "This book has no speaker by that name", `Not in the cast: ${missing.join(", ")}.`);

  const judge = (
    read: ReadFile,
  ): { speaker: string; folder: string; voice: ScriptFileVoice; clips: JudgedClip[] }[] =>
    names.map((speaker) => {
      const entry = read.cast.find((c) => c.name === speaker);
      const folder = folderOf(entry?.samples);
      if (!folder)
        fail(400, "That file carries no recordings for this speaker", `Speaker: ${speaker}.`);
      const verdict = judgeVoiceFolder(folder, read.voices, limits);
      if (!verdict.ok)
        fail(400, `The recordings for ${speaker} could not be kept`, `${verdict.reason}.`);
      return { speaker, folder, voice: verdict.voice, clips: verdict.clips };
    });
  const heads = await readScriptFile(upload, limits);
  const folders = judge(heads).map((j) => `${heads.root}${j.folder}`);
  const whole = await readScriptFile(upload, limits, {
    whole: (path) => folders.some((f) => path.startsWith(f)),
  });
  const judged = judge(whole);
  if (judged.some((j) => j.clips.some((c) => c.partial)))
    fail(500, "The recordings were not read whole", "This is a bug; nothing was kept.");

  // Files first, then rows; on failure remove only the files this call wrote that no row names.
  const before = namedFiles(db, bookId);
  const written: string[] = [];
  try {
    const kept: KeepSpeakerSamples[] = [];
    for (const j of judged) {
      const clips: KeptSample[] = [];
      for (const clip of j.clips) {
        const file = await files.write(bookId, clip.bytes, clip.format);
        written.push(file);
        clips.push({ file, name: clip.name, format: clip.format, bytes: clip.bytes.length });
      }
      kept.push({ ...j, clips });
    }
    return keepSpeakerSamples(db, bookId, kept, upload.name, now());
  } catch (e) {
    const orphans = [...new Set(written)].filter((f) => !before.has(f));
    const still = namedFiles(db, bookId);
    await files.remove(
      bookId,
      orphans.filter((f) => !still.has(f)),
    );
    throw e;
  }
}

export function discardSamples(
  db: Db,
  bookId: string,
  id: number,
  { now = Date.now }: SampleOptions = {},
): { id: number } {
  requireBook(db, bookId);
  const row = sampleRow(db, bookId, id);
  if (!row || row.discardedAt != null) throw notFound("There are no recordings waiting by that id");
  setDiscarded(db, id, now());
  return { id };
}

export function restoreSamples(db: Db, bookId: string, id: number): SpeakerSamples {
  requireBook(db, bookId);
  const row = sampleRow(db, bookId, id);
  if (!row) throw notFound("Those recordings are gone", "They were discarded more than a day ago.");
  setDiscarded(db, id, null);
  return toSpeakerSamples(db, { ...row, discardedAt: null });
}

export function sampleFile(
  db: Db,
  files: SpeakerSampleFiles,
  bookId: string,
  id: number,
  file: string,
): { path: string; format: SampleFormat } {
  const row = sampleRow(db, bookId, id);
  const kept = row && row.discardedAt == null ? filesOf(db, id).find((f) => f.file === file) : null;
  const path = kept ? files.path(bookId, file) : null;
  if (!kept || !path) throw notFound("There is no recording by that name");
  return { path, format: kept.format };
}
