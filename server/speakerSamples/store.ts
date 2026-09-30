// Voice samples waiting with a speaker: kept from a script file, read, discarded, restored and, a
// day after a discard, removed. See docs/script-transfer.md, slice 3.
//
// **Stored when the import is applied, never when it is planned.** The plan route writes nothing;
// the page, once the person applies, sends the same file back with the speakers whose recordings
// it should keep, and this reads it again through the same guard and the same judgement.
//
// **A discard is undoable, the way a forget is.** Slice 2's forget hides a voice's recordings and
// removes them a day later; a discard here does the same, so the toast's Undo can bring them back.
// The removal happens on the next read of the book's samples after the grace period.
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
  /** the clock a discard is stamped and a purge judged by; the real one unless a test moves it */
  now?: () => number;
  /** what one voice's recordings may come to; the clone route's unless a test lowers them */
  limits?: SampleLimits;
}

// ---------- reading ----------

/** A voice an export carries again: the speaker, the consent, and how to read each recording. */
export interface WaitingVoice {
  speaker: string;
  title: string;
  /** epoch ms */
  consentAt: number;
  consentText: string;
  samples: {
    name: string;
    format: SampleFormat;
    bytes: number;
    read(): Promise<Uint8Array>;
  }[];
}

/**
 * The recordings still waiting with this book's speakers, for an export to carry again with the
 * consent they came under. A discarded row is not carried: the person said they are not wanted.
 */
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
      consentAt: w.consentAt,
      consentText: w.consentText,
      // A recording gone from disk — removed by hand, a folder cleared — is left out rather than
      // failing the export, and a voice with none left is not carried at all.
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

/**
 * The samples waiting in this book, after removing any a discard left behind longer than the
 * grace period — the read is where that happens, as a save of the endpoints is for slice 2.
 */
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

/** Remove the rows discarded longer ago than the grace period, then the files nothing names. */
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
 * Keep the recordings `upload` carries for `speakers`, with the consent the file records for them.
 *
 * Every speaker must be one this book has, and one whose recordings the file carries and the
 * judgement passes: this is the apply step of a plan the page already showed, so a speaker that
 * fails here is a request that does not match the plan, refused whole. A speaker who already has
 * recordings waiting has them put aside the soft way — discarded, not deleted — so the import's
 * Undo can bring them back; `replaced` names those rows.
 *
 * The file is read twice: once holding only the head of each recording, to learn from the cast
 * which folders these speakers' recordings are in, and again holding whole recordings from those
 * folders alone — so a file carrying twenty voices keeps in memory only the ones asked for.
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

  // Written first, then named by rows in one transaction; a failure between leaves no file that
  // no row names — except one another row already named, which was never this call's to remove.
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

/** Hide one row's recordings now; the read a day later removes them unless Undo came first. */
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

/** Take back a discard; a row already removed by the purge is gone for good. */
export function restoreSamples(db: Db, bookId: string, id: number): SpeakerSamples {
  requireBook(db, bookId);
  const row = sampleRow(db, bookId, id);
  if (!row) throw notFound("Those recordings are gone", "They were discarded more than a day ago.");
  setDiscarded(db, id, null);
  return toSpeakerSamples(db, { ...row, discardedAt: null });
}

/** Where one waiting recording is on disk, and what it is; 404 for anything else. */
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
