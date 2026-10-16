// Recordings a script file brought for a book's speakers: one row per speaker, files in order.
// Discards are soft (`discarded_at`) so Undo works; rules and purge timing live in
// server/speakerSamples/store.ts.
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import type { KeptSample, ScriptFileVoice, SpeakerSamples } from "@/types";
import type { Db, Tx } from "~/db/client";
import { speakerSampleFiles as filesTable, speakerSamples } from "~/db/schema";

export type SampleRow = typeof speakerSamples.$inferSelect;

export interface KeepSpeakerSamples {
  speaker: string;
  voice: ScriptFileVoice;
  clips: KeptSample[];
}

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

export const toSpeakerSamples = (db: Db | Tx, r: SampleRow): SpeakerSamples => ({
  id: r.id,
  speaker: r.speaker,
  title: r.title,
  source: r.source,
  samples: filesOf(db, r.id),
});

/** Discarded or not. */
export function sampleRow(db: Db | Tx, bookId: string, id: number): SampleRow | undefined {
  return db
    .select()
    .from(speakerSamples)
    .where(and(eq(speakerSamples.bookId, bookId), eq(speakerSamples.id, id)))
    .get();
}

/** Files a removal must leave on disk. */
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

/** Oldest first, discarded rows excluded. */
export function waitingSamples(db: Db | Tx, bookId: string): SpeakerSamples[] {
  return db
    .select()
    .from(speakerSamples)
    .where(and(eq(speakerSamples.bookId, bookId), isNull(speakerSamples.discardedAt)))
    .orderBy(asc(speakerSamples.id))
    .all()
    .map((r) => toSpeakerSamples(db, r));
}

/** Returns files no row names any more, for the caller to delete from disk. */
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

/** A speaker's waiting recordings are soft-discarded and listed in `replaced` for Undo. */
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

/** `null` takes the discard back. */
export function setDiscarded(db: Db | Tx, id: number, at: number | null): void {
  db.update(speakerSamples).set({ discardedAt: at }).where(eq(speakerSamples.id, id)).run();
}

const waitingWith = (bookId: string, name: string) =>
  and(
    eq(speakerSamples.bookId, bookId),
    eq(speakerSamples.speaker, name),
    isNull(speakerSamples.discardedAt),
  );

/**
 * For a merge; a cascade from the removed speaker would orphan the files on disk. Returns the
 * waiting rows moved, for an Undo to give back (`giveBackSamples`).
 */
export function moveSpeakerSamples(
  tx: Db | Tx,
  bookId: string,
  from: string,
  into: string,
): number[] {
  const waiting = tx
    .select({ id: speakerSamples.id })
    .from(speakerSamples)
    .where(waitingWith(bookId, from))
    .all()
    .map((r) => r.id);
  tx.update(speakerSamples)
    .set({ speaker: into })
    .where(and(eq(speakerSamples.bookId, bookId), eq(speakerSamples.speaker, from)))
    .run();
  return waiting;
}

/**
 * For a removed speaker: soft-discarded and re-pointed at the Narrator (only to satisfy the foreign
 * key), then purged with their files, instead of cascading and orphaning the files. Returns the
 * rows that were waiting, for an Undo to give back.
 */
export function discardSpeakerSamples(
  tx: Db | Tx,
  bookId: string,
  name: string,
  holder: string,
  at = Date.now(),
): number[] {
  const waiting = tx
    .update(speakerSamples)
    .set({ speaker: holder, discardedAt: at })
    .where(waitingWith(bookId, name))
    .returning({ id: speakerSamples.id })
    .all()
    .map((r) => r.id);
  tx.update(speakerSamples)
    .set({ speaker: holder })
    .where(and(eq(speakerSamples.bookId, bookId), eq(speakerSamples.speaker, name)))
    .run();
  return waiting;
}

/** The Undo of a merge or removal: these rows wait with `speaker` again. Purged ones are gone. */
export function giveBackSamples(
  tx: Db | Tx,
  bookId: string,
  ids: readonly number[],
  speaker: string,
): void {
  if (!ids.length) return;
  tx.update(speakerSamples)
    .set({ speaker, discardedAt: null })
    .where(and(eq(speakerSamples.bookId, bookId), inArray(speakerSamples.id, [...ids])))
    .run();
}
