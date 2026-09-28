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

import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import type { KeptSample, ScriptFileVoice, SpeakerSamples } from "@/types";
import { readCast } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { getBook } from "~/db/library";
import { speakerSampleFiles as filesTable, speakerSamples } from "~/db/schema";
import { GRACE_MS } from "~/db/voiceSamples";
import { inBackground } from "~/lib/background";
import { fail, notFound } from "~/lib/errors";
import type { RecordingFormat } from "~/providers/clone";
import { readScriptFile, type ReadFile, type ScriptUpload } from "~/script/importPlan";
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

type Row = typeof speakerSamples.$inferSelect;

function filesOf(db: Db | Tx, id: number): KeptSample[] {
  return db
    .select({
      file: filesTable.file,
      name: filesTable.name,
      format: filesTable.format,
      bytes: filesTable.bytes,
    })
    .from(filesTable)
    .where(eq(filesTable.sampleId, id))
    .orderBy(asc(filesTable.position))
    .all();
}

const shapeOf = (db: Db | Tx, r: Row): SpeakerSamples => ({
  id: r.id,
  speaker: r.speaker,
  title: r.title,
  consentAt: r.consentAt,
  consentText: r.consentText,
  source: r.source,
  samples: filesOf(db, r.id),
});

/** One row of this book's, discarded or not; undefined when there is none. */
function rowOf(db: Db | Tx, bookId: string, id: number): Row | undefined {
  return db
    .select()
    .from(speakerSamples)
    .where(and(eq(speakerSamples.bookId, bookId), eq(speakerSamples.id, id)))
    .get();
}

/** Every file a row of this book still names — which a removal must leave on disk. */
function namedFiles(db: Db | Tx, bookId: string): Set<string> {
  return new Set(
    db
      .select({ file: filesTable.file })
      .from(filesTable)
      .innerJoin(speakerSamples, eq(speakerSamples.id, filesTable.sampleId))
      .where(eq(speakerSamples.bookId, bookId))
      .all()
      .map((r) => r.file),
  );
}

/** The samples waiting in this book, oldest first; a discarded row is not among them. */
export function waitingSamples(db: Db | Tx, bookId: string): SpeakerSamples[] {
  return db
    .select()
    .from(speakerSamples)
    .where(and(eq(speakerSamples.bookId, bookId), isNull(speakerSamples.discardedAt)))
    .orderBy(asc(speakerSamples.id))
    .all()
    .map((r) => shapeOf(db, r));
}

/** A voice an export carries again: the speaker, the consent, and how to read each recording. */
export interface WaitingVoice {
  speaker: string;
  title: string;
  /** epoch ms */
  consentAt: number;
  consentText: string;
  samples: {
    name: string;
    format: RecordingFormat;
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
  const gone = db.transaction((tx) => {
    const expired = tx
      .select({ id: speakerSamples.id })
      .from(speakerSamples)
      .where(
        and(
          eq(speakerSamples.bookId, bookId),
          isNotNull(speakerSamples.discardedAt),
          lt(speakerSamples.discardedAt, now - GRACE_MS),
        ),
      )
      .all()
      .map((r) => r.id);
    if (!expired.length) return [];
    const named = expired.flatMap((id) => filesOf(tx, id).map((f) => f.file));
    tx.delete(speakerSamples).where(inArray(speakerSamples.id, expired)).run();
    const still = namedFiles(tx, bookId);
    return named.filter((f) => !still.has(f));
  });
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
): Promise<{ stored: SpeakerSamples[]; replaced: number[] }> {
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
    const kept: { speaker: string; voice: ScriptFileVoice; clips: KeptSample[] }[] = [];
    for (const j of judged) {
      const clips: KeptSample[] = [];
      for (const clip of j.clips) {
        const file = await files.write(bookId, clip.bytes, clip.format);
        written.push(file);
        clips.push({ file, name: clip.name, format: clip.format, bytes: clip.bytes.length });
      }
      kept.push({ ...j, clips });
    }
    return db.transaction((tx) => {
      const replaced: number[] = [];
      const stored: SpeakerSamples[] = [];
      const at = now();
      for (const k of kept) {
        const old = tx
          .select({ id: speakerSamples.id })
          .from(speakerSamples)
          .where(
            and(
              eq(speakerSamples.bookId, bookId),
              eq(speakerSamples.speaker, k.speaker),
              isNull(speakerSamples.discardedAt),
            ),
          )
          .all()
          .map((o) => o.id);
        replaced.push(...old);
        if (old.length)
          tx.update(speakerSamples)
            .set({ discardedAt: at })
            .where(inArray(speakerSamples.id, old))
            .run();
        const row = tx
          .insert(speakerSamples)
          .values({
            bookId,
            speaker: k.speaker,
            title: k.voice.title,
            consentAt: Date.parse(k.voice.consentAt),
            consentText: k.voice.consentText,
            source: upload.name,
            storedAt: at,
          })
          .returning()
          .get();
        // the same recording carried twice in one voice is one file, kept once
        const seen = new Set<string>();
        k.clips.forEach((c, position) => {
          if (seen.has(c.file)) return;
          seen.add(c.file);
          tx.insert(filesTable)
            .values({ sampleId: row.id, ...c, position })
            .run();
        });
        stored.push(shapeOf(tx, row));
      }
      return { stored, replaced };
    });
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
  const row = rowOf(db, bookId, id);
  if (!row || row.discardedAt != null) throw notFound("There are no recordings waiting by that id");
  db.update(speakerSamples).set({ discardedAt: now() }).where(eq(speakerSamples.id, id)).run();
  return { id };
}

/**
 * A merge folds one speaker into another: the lines go to them, and so do the recordings waiting
 * for either — it is one person, cloned or not, and a cascade from the removed row would drop the
 * rows and leave their files on disk with nothing naming them.
 */
export function moveSpeakerSamples(tx: Db | Tx, bookId: string, from: string, into: string): void {
  tx.update(speakerSamples)
    .set({ speaker: into })
    .where(and(eq(speakerSamples.bookId, bookId), eq(speakerSamples.speaker, from)))
    .run();
}

/**
 * Taking a speaker off the cast leaves their recordings nobody to wait for. They are discarded the
 * soft way — held by the Narrator's row only so the foreign key has somewhere to point, hidden at
 * once, and purged with their files a day later — rather than cascaded away with their files left
 * behind.
 */
export function discardSpeakerSamples(
  tx: Db | Tx,
  bookId: string,
  name: string,
  holder: string,
  { now = Date.now }: SampleOptions = {},
): void {
  const at = now();
  tx.update(speakerSamples)
    .set({ speaker: holder, discardedAt: at })
    .where(
      and(
        eq(speakerSamples.bookId, bookId),
        eq(speakerSamples.speaker, name),
        isNull(speakerSamples.discardedAt),
      ),
    )
    .run();
  tx.update(speakerSamples)
    .set({ speaker: holder })
    .where(and(eq(speakerSamples.bookId, bookId), eq(speakerSamples.speaker, name)))
    .run();
}

/** Take back a discard; a row already removed by the purge is gone for good. */
export function restoreSamples(db: Db, bookId: string, id: number): SpeakerSamples {
  requireBook(db, bookId);
  const row = rowOf(db, bookId, id);
  if (!row) throw notFound("Those recordings are gone", "They were discarded more than a day ago.");
  db.update(speakerSamples).set({ discardedAt: null }).where(eq(speakerSamples.id, id)).run();
  return shapeOf(db, { ...row, discardedAt: null });
}

/** Where one waiting recording is on disk, and what it is; 404 for anything else. */
export function sampleFile(
  db: Db,
  files: SpeakerSampleFiles,
  bookId: string,
  id: number,
  file: string,
): { path: string; format: RecordingFormat } {
  const row = rowOf(db, bookId, id);
  const kept = row && row.discardedAt == null ? filesOf(db, id).find((f) => f.file === file) : null;
  const path = kept ? files.path(bookId, file) : null;
  if (!kept || !path) throw notFound("There is no recording by that name");
  return { path, format: kept.format };
}
