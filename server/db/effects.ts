// Voice effects: their reads and writes, and what a line's effects are read from.
// Effects are named by id from text columns with no foreign key (they also hold "none"), so
// deleting one resets those names here, in the same transaction.
import { and, asc, eq, gte, inArray, isNotNull, max, or, sql } from "drizzle-orm";

import type { Effect, EffectUses, StaleSound } from "@/types";
import { chainsFor, soundOf, type EffectContext } from "@/lib/effects";
import type { Db, Tx } from "~/db/client";
import { books, characters, clips, effects, segments } from "~/db/schema";
import { readThoughts, writeThoughts } from "~/db/settings";

/** A fresh library's thought effect; migration 0031 also lays it down in an existing library. */
export const INNER_VOICE: Effect = {
  id: "inner-voice",
  name: "Inner voice",
  chain: [
    { plugin: "HighpassFilter", params: { cutoff_frequency_hz: 220 }, on: true },
    { plugin: "LowpassFilter", params: { cutoff_frequency_hz: 6000 }, on: true },
    { plugin: "PeakFilter", params: { cutoff_frequency_hz: 2500, gain_db: -4, q: 1 }, on: true },
    { plugin: "Compressor", params: { threshold_db: -20, ratio: 3 }, on: true },
    {
      plugin: "Reverb",
      params: { room_size: 0.12, damping: 0.5, wet_level: 0.18, dry_level: 0.9 },
      on: true,
    },
    { plugin: "Gain", params: { gain_db: -1 }, on: true },
  ],
};

export function seedEffects(db: Db | Tx): void {
  db.insert(effects)
    .values({ ...INNER_VOICE, position: 0 })
    .onConflictDoNothing()
    .run();
  writeThoughts(db, INNER_VOICE.id);
}

const columns = {
  id: effects.id,
  name: effects.name,
  chain: effects.chain,
  useWhen: effects.useWhen,
};

/** A row as an `Effect`: no `useWhen` key when it has none. */
function toEffect({ useWhen, ...e }: Omit<Effect, "useWhen"> & { useWhen: string | null }): Effect {
  return useWhen != null ? { ...e, useWhen } : e;
}

export type EffectBody = Omit<Effect, "id">;

/** Listed order is also the order a line's own effects run in. */
export function listEffects(db: Db | Tx): Effect[] {
  return db
    .select(columns)
    .from(effects)
    .orderBy(asc(effects.position), asc(effects.name))
    .all()
    .map(toEffect);
}

export function getEffect(db: Db | Tx, id: string): Effect | undefined {
  const row = db.select(columns).from(effects).where(eq(effects.id, id)).get();
  return row && toEffect(row);
}

/**
 * Id is the slug made free (`echo`, `echo-2`, …); never "none", which means no effect. Goes right
 * after `after`, or at the end when `after` is absent or unknown.
 */
export function createEffect(db: Db, slug: string, body: EffectBody, after?: string): Effect {
  return db.transaction((tx) => {
    const taken = new Set([
      "none",
      ...tx
        .select({ id: effects.id })
        .from(effects)
        .all()
        .map((r) => r.id),
    ]);
    let id = slug;
    for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
    const prev =
      after === undefined
        ? undefined
        : tx.select({ p: effects.position }).from(effects).where(eq(effects.id, after)).get();
    let position: number;
    if (prev?.p != null) {
      position = prev.p + 1;
      tx.update(effects)
        .set({ position: sql`${effects.position} + 1` })
        .where(gte(effects.position, position))
        .run();
    } else {
      position =
        (tx
          .select({ n: max(effects.position) })
          .from(effects)
          .get()?.n ?? -1) + 1;
    }
    tx.insert(effects)
      .values({ id, ...body, useWhen: body.useWhen ?? null, position })
      .run();
    return { id, ...body };
  });
}

/** Replaces the whole body; a `useWhen` left out is cleared. */
export function updateEffect(db: Db | Tx, id: string, body: EffectBody): Effect | undefined {
  const row = db
    .update(effects)
    .set({ name: body.name, chain: body.chain, useWhen: body.useWhen ?? null })
    .where(eq(effects.id, id))
    .returning(columns)
    .get();
  return row && toEffect(row);
}

/**
 * Also clears every choice of it (the library's thought effect goes to "none", not another effect)
 * and strips it from line effects, so a later effect with the same id is not heard on them.
 */
export function deleteEffect(db: Db, id: string): boolean {
  return db.transaction((tx) => {
    const wasLibrary = readThoughts(tx) === id;
    const gone = tx.delete(effects).where(eq(effects.id, id)).returning({ id: effects.id }).all();
    if (!gone.length) return false;
    tx.update(books).set({ thoughts: null }).where(eq(books.thoughts, id)).run();
    tx.update(characters).set({ thoughts: null }).where(eq(characters.thoughts, id)).run();
    tx.update(characters).set({ effect: null }).where(eq(characters.effect, id)).run();
    if (wasLibrary) writeThoughts(tx, "none");
    // none left is null, as an empty list is written
    tx.update(segments)
      .set({
        effects: sql`(SELECT CASE WHEN count(*) > 0 THEN json_group_array(value) END
          FROM json_each(${segments.effects}) WHERE value <> ${id})`,
      })
      .where(sql`EXISTS (SELECT 1 FROM json_each(${segments.effects}) WHERE value = ${id})`)
      .run();
    return true;
  });
}

/** Everywhere an effect is chosen, across every book. */
export function effectUses(db: Db | Tx, id: string): EffectUses {
  return {
    library: readThoughts(db) === id,
    books: db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(eq(books.thoughts, id))
      .orderBy(asc(books.title))
      .all(),
    speakers: db
      .select({
        bookId: books.id,
        bookTitle: books.title,
        name: characters.name,
        effect: sql<boolean>`${characters.effect} IS ${id}`.mapWith(Boolean),
        thoughts: sql<boolean>`${characters.thoughts} IS ${id}`.mapWith(Boolean),
      })
      .from(characters)
      .innerJoin(books, eq(books.id, characters.bookId))
      .where(or(eq(characters.effect, id), eq(characters.thoughts, id)))
      .orderBy(asc(books.title), asc(characters.name))
      .all(),
  };
}

/** Input to `chainsFor`, read once per book. */
export function effectContext(db: Db | Tx, bookId: string): EffectContext {
  const cast = db
    .select({
      name: characters.name,
      effect: characters.effect,
      thoughts: characters.thoughts,
      personaOf: characters.personaOf,
    })
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .all();
  return {
    effects: new Map(listEffects(db).map((e) => [e.id, e])),
    library: readThoughts(db),
    book: db.select({ t: books.thoughts }).from(books).where(eq(books.id, bookId)).get()?.t ?? null,
    cast: new Map(
      cast
        .filter((c) => c.effect != null || c.thoughts != null || c.personaOf != null)
        .map((c) => [
          c.name,
          {
            ...(c.effect != null ? { effect: c.effect } : {}),
            ...(c.thoughts != null ? { thoughts: c.thoughts } : {}),
            ...(c.personaOf != null ? { personaOf: c.personaOf } : {}),
          },
        ]),
    ),
  };
}

// ---------- Re-apply ----------

/** A clip in a book whose sound is not what its line's effects now make. */
export interface StaleClip {
  chapterId: number;
  segmentId: number;
  url: string;
  /** the voice's own file, when `url` is not it */
  raw: string | null;
  sound: string | null;
  /** what its line runs through now; empty = the raw file is the clip */
  effects: Effect[];
  /** `soundOf(effects)` */
  want: string | null;
}

/** A clip with effects in it and no raw file to make it again from: an old ffmpeg thought clip. */
export const cannotRedo = (c: Pick<StaleClip, "raw" | "sound">): boolean =>
  c.raw == null && c.sound != null;

/**
 * Finished current/candidate clips whose sound is stale; takes are history and left alone.
 * Effects are worked out once per (thought?, speaker, line effects), not per line, for scale.
 */
export function staleClips(db: Db | Tx, bookId: string): StaleClip[] {
  const ctx = effectContext(db, bookId);
  const rows = db
    .select({
      chapterId: clips.chapterId,
      segmentId: clips.segmentId,
      url: clips.url,
      raw: clips.raw,
      sound: clips.sound,
      type: segments.type,
      speaker: segments.speaker,
      lineEffects: segments.effects,
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
    .where(
      and(
        eq(clips.bookId, bookId),
        inArray(clips.role, ["current", "candidate"]),
        eq(clips.status, "done"),
        isNotNull(clips.url),
      ),
    )
    .all();
  const known = new Map<string, Pick<StaleClip, "effects" | "want">>();
  const out: StaleClip[] = [];
  for (const { type, speaker, lineEffects, url, ...r } of rows) {
    const key = JSON.stringify([type === "thought", speaker, lineEffects]);
    let line = known.get(key);
    if (!line) {
      const effects = chainsFor({ type, speaker, effects: lineEffects ?? undefined }, ctx);
      line = { effects, want: soundOf(effects) };
      known.set(key, line);
    }
    if (r.sound !== line.want) out.push({ ...r, url: url!, ...line });
  }
  return out;
}

export function staleSound(db: Db | Tx, bookId: string): Omit<StaleSound, "ready"> {
  const stale = staleClips(db, bookId);
  return { lines: stale.length, unavailable: stale.filter(cannotRedo).length };
}

/**
 * Swaps a re-applied file into whichever slot still plays `was`. Empty when none does (the line was
 * re-narrated or rescripted while the file was made).
 */
export function swapClipFile(
  tx: Tx,
  bookId: string,
  was: string,
  next: {
    url: string;
    raw: string | null;
    sound: string | null;
    duration: number;
    sampleRate: number;
  },
): { chapterId: number; role: string }[] {
  return tx
    .update(clips)
    .set(next)
    .where(
      and(
        eq(clips.bookId, bookId),
        eq(clips.url, was),
        inArray(clips.role, ["current", "candidate"]),
      ),
    )
    .returning({ chapterId: clips.chapterId, role: clips.role })
    .all();
}
