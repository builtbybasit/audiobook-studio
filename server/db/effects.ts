// Every read and write the library's voice effects make, and what a line's effects are read from.
//
// An effect is named by id from text columns that also hold "none" — a book's and a speaker's
// thought effect, a speaker's own, the library's in `settings` — with no foreign key behind them,
// so removing one resets those names here, in the same transaction, rather than leaving them
// pointing at nothing.
import { asc, eq, max } from "drizzle-orm";

import type { Effect, Step } from "@/types";
import type { EffectContext } from "@/lib/effects";
import type { Db, Tx } from "~/db/client";
import { books, characters, effects } from "~/db/schema";
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

const columns = { id: effects.id, name: effects.name, chain: effects.chain };

/** Every effect, in the order they are listed. */
export function listEffects(db: Db | Tx): Effect[] {
  return db.select(columns).from(effects).orderBy(asc(effects.position), asc(effects.name)).all();
}

export function getEffect(db: Db | Tx, id: string): Effect | undefined {
  return db.select(columns).from(effects).where(eq(effects.id, id)).get();
}

/**
 * A new effect at the end of the list, its id the slug it is given made free: `echo`, then
 * `echo-2`, … "none" is never one, since it is what a choice of no effect is written as.
 */
export function createEffect(db: Db | Tx, slug: string, name: string, chain: Step[]): Effect {
  const taken = new Set([
    "none",
    ...db
      .select({ id: effects.id })
      .from(effects)
      .all()
      .map((r) => r.id),
  ]);
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
  const position =
    (db
      .select({ n: max(effects.position) })
      .from(effects)
      .get()?.n ?? -1) + 1;
  db.insert(effects).values({ id, name, chain, position }).run();
  return { id, name, chain };
}

/** Rename an effect or replace its chain; its id stays. Undefined when there is no such effect. */
export function updateEffect(
  db: Db | Tx,
  id: string,
  name: string,
  chain: Step[],
): Effect | undefined {
  return db.update(effects).set({ name, chain }).where(eq(effects.id, id)).returning(columns).get();
}

/**
 * Remove an effect, and every choice of it: a book's or a speaker's thought effect goes back to
 * following the next level, a speaker's own to none, and the library's thought effect to none —
 * not to another effect nobody picked. False when there was no such effect.
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
    return true;
  });
}

/** What a book's lines' effects are read from (`chainsFor`): narration and Re-apply read it once. */
export function effectContext(db: Db | Tx, bookId: string): EffectContext {
  const cast = db
    .select({ name: characters.name, effect: characters.effect, thoughts: characters.thoughts })
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .all();
  return {
    effects: new Map(listEffects(db).map((e) => [e.id, e])),
    library: readThoughts(db),
    book: db.select({ t: books.thoughts }).from(books).where(eq(books.id, bookId)).get()?.t ?? null,
    cast: new Map(
      cast
        .filter((c) => c.effect != null || c.thoughts != null)
        .map((c) => [
          c.name,
          {
            ...(c.effect != null ? { effect: c.effect } : {}),
            ...(c.thoughts != null ? { thoughts: c.thoughts } : {}),
          },
        ]),
    ),
  };
}
