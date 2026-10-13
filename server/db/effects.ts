// Every read and write the library's voice effects make, and what a line's effects are read from.
//
// An effect is named by id from text columns that also hold "none" — a book's and a speaker's
// thought effect, a speaker's own, the library's in `settings` — with no foreign key behind them,
// so removing one resets those names here, in the same transaction, rather than leaving them
// pointing at nothing.
import { and, asc, eq, gte, inArray, isNotNull, max, or, sql } from "drizzle-orm";

import type { Effect, EffectUses, StaleSound } from "@/types";
import { chainsFor, soundOf, type EffectContext } from "@/lib/effects";
import type { Db, Tx } from "~/db/client";
import { books, characters, clips, effects, segments } from "~/db/schema";
import { readThoughts, writeThoughts } from "~/db/settings";

/**
 * The effect a library starts with as its thought effect: the ffmpeg chain narration used before
 * there were effects, in Pedalboard's terms. Migration 0031 lays it down in a library that was
 * already there, and the demo's seed in a demo put back the way it started.
 */
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

/** What a fresh library has: the Inner voice, and it as the thought effect. */
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

/** What an effect is made of besides its id: what a create or an update writes, whole. */
export type EffectBody = Omit<Effect, "id">;

/** Every effect, in the order they are listed — also the order a line's own effects run in. */
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
 * A new effect, its id the slug it is given made free: `echo`, then `echo-2`, … "none" is never
 * one, since it is what a choice of no effect is written as. It goes right after the effect `after`
 * names, the ones below moving down one in the same transaction, or at the end of the list without
 * it — or when it names no effect, which the caller refuses first (`server/effects/ops.ts`).
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

/**
 * Replace an effect's name, chain and `useWhen` — a `useWhen` left out is cleared; its id stays.
 * Undefined when there is no such effect.
 */
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
 * Remove an effect, and every choice of it: a book's or a speaker's thought effect goes back to
 * following the next level, a speaker's own to none, the library's thought effect to none — not
 * to another effect nobody picked — and every line that has it as a line effect loses it, so a
 * later effect given the same id is not heard on them. False when there was no such effect.
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
    // the line's other effects kept in their order; none left is null, as an empty list is written
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

/**
 * Everywhere an effect is chosen, across every book: the library's thought effect, the books that
 * choose it as their own, and the speakers that wear it or think in it. One query per table,
 * ordered by book title and then speaker name.
 */
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

/** What a book's lines' effects are read from (`chainsFor`): narration and Re-apply read it once. */
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
  /** the file it plays */
  url: string;
  /** the voice's own file, when `url` is not it */
  raw: string | null;
  sound: string | null;
  /** what its line is run through now, in order; none = the raw file is the clip */
  effects: Effect[];
  /** `soundOf(effects)` */
  want: string | null;
}

/** A clip with effects in it and no raw file to make it again from: an old ffmpeg thought clip. */
export const cannotRedo = (c: Pick<StaleClip, "raw" | "sound">): boolean =>
  c.raw == null && c.sound != null;

/**
 * Every finished clip in a book's current and retake slots whose sound is not its line's now. One
 * query over the book, and a line's effects worked out once per speaker, kind of line and set of
 * line effects rather than once per line, so a book of 900 chapters is one pass. (A persona's
 * character is fixed by its speaker, so the speaker keys that too.) Takes are history and are left as
 * they were made.
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

/** How many of a book's clips have an old sound, and how many of those cannot be redone. */
export function staleSound(db: Db | Tx, bookId: string): Omit<StaleSound, "ready"> {
  const stale = staleClips(db, bookId);
  return { lines: stale.length, unavailable: stale.filter(cannotRedo).length };
}

/**
 * Put a re-applied file in place of the clip that played `was`, in whichever slot of the book's
 * still plays it, and say where that was — nothing when no slot does any more: the line was
 * narrated again, its retake kept, or its script written over while the file was made.
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
