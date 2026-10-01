// Every read and write of the recordings kept with a book's speakers from a script file.
//
// A row is one speaker's set of recordings; its files are rows of their own, in order. A discard is soft — `discarded_at` is stamped and the row stays until the
// purge — so an Undo has something to bring back. What the rules are, and when the purge runs, is
// `server/speakerSamples/store.ts`'s; this file only reads and writes.
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import type { KeptSample, ScriptFileVoice, SpeakerSamples } from "@/types";
import type { Db, Tx } from "~/db/client";
import { speakerSampleFiles as filesTable, speakerSamples } from "~/db/schema";

export type SampleRow = typeof speakerSamples.$inferSelect;

/** A speaker's recordings as a script file brought them, to be kept under one new row. */
export interface KeepSpeakerSamples {
  speaker: string;
  voice: ScriptFileVoice;
  clips: KeptSample[];
}

/** The files a row names, in the order they were kept. */
export function filesOf(db: Db | Tx, id: number): KeptSample[] {
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

/** A row as the page reads it, with its files. */
export const toSpeakerSamples = (db: Db | Tx, r: SampleRow): SpeakerSamples => ({
  id: r.id,
  speaker: r.speaker,
  title: r.title,
  source: r.source,
  samples: filesOf(db, r.id),
});

/** One row of this book's, discarded or not; undefined when there is none. */
export function sampleRow(db: Db | Tx, bookId: string, id: number): SampleRow | undefined {
  return db
    .select()
    .from(speakerSamples)
    .where(and(eq(speakerSamples.bookId, bookId), eq(speakerSamples.id, id)))
    .get();
}

/** Every file a row of this book still names — which a removal must leave on disk. */
export function namedFiles(db: Db | Tx, bookId: string): Set<string> {
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
    .map((r) => toSpeakerSamples(db, r));
}

/**
 * Remove the rows of this book discarded before `before`, in one transaction, and answer with the
 * files they named that no row names any more, for the caller to remove from disk.
 */
export function purgeDiscardedRows(db: Db, bookId: string, before: number): string[] {
  return db.transaction((tx) => {
    const expired = tx
      .select({ id: speakerSamples.id })
      .from(speakerSamples)
      .where(
        and(
          eq(speakerSamples.bookId, bookId),
          isNotNull(speakerSamples.discardedAt),
          lt(speakerSamples.discardedAt, before),
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
}

/**
 * Keep each speaker's recordings under a new row, in one transaction. A speaker who already has
 * recordings waiting has them discarded the soft way, and `replaced` names those rows so an Undo
 * can bring them back. The same file named twice in one voice is one file, kept once.
 */
export function keepSpeakerSamples(
  db: Db,
  bookId: string,
  kept: readonly KeepSpeakerSamples[],
  source: string,
  at: number,
): { stored: SpeakerSamples[]; replaced: number[] } {
  return db.transaction((tx) => {
    const replaced: number[] = [];
    const stored: SpeakerSamples[] = [];
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
          source,
          storedAt: at,
        })
        .returning()
        .get();
      const seen = new Set<string>();
      k.clips.forEach((c, position) => {
        if (seen.has(c.file)) return;
        seen.add(c.file);
        tx.insert(filesTable)
          .values({ sampleId: row.id, ...c, position })
          .run();
      });
      stored.push(toSpeakerSamples(tx, row));
    }
    return { stored, replaced };
  });
}

/** Stamp a row discarded at `at`, or — `null` — take the discard back. */
export function setDiscarded(db: Db | Tx, id: number, at: number | null): void {
  db.update(speakerSamples).set({ discardedAt: at }).where(eq(speakerSamples.id, id)).run();
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
  at = Date.now(),
): void {
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
