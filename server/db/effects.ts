// Voice effects: their reads and writes, and what a line's effects are read from.
// Effects are named by id from text columns with no foreign key (they also hold "none"), so
// deleting one resets those names here, in the same transaction.
import { and, asc, eq, gte, inArray, isNotNull, max, or, sql } from "drizzle-orm";

import type { Effect, EffectUses, ExistingChapter, ExistingScope, StaleSound } from "@/types";
import { chainsFor, soundOf, type EffectContext } from "@/lib/effects";
import type { Db, Tx } from "~/db/client";
import { books, chapters, characters, clips, effects, keptSounds, segments } from "~/db/schema";
import { readThoughts, writeThoughts } from "~/db/settings";

/** A fresh library's thought effect, as migrations 0031 and 0036 lay it down. */
export const INNER_VOICE: Effect = {
  id: "inner-voice",
  name: "Inner voice",
  chain: [
    {
      plugin: "Reverb",
      params: { room_size: 0.55, damping: 0.48, wet_level: 0.62, dry_level: 0.74, width: 0.85 },
      on: true,
    },
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
 * Finished current/candidate clips whose sound is stale, in the chapters kept in the book; takes are
 * history and left alone, and so is a clip kept against the sound its line wants now. Effects are
 * worked out once per (thought?, speaker, line effects), not per line, for scale.
 */
export function staleClips(db: Db | Tx, bookId: string, scope: ExistingScope = {}): StaleClip[] {
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
      kept: keptSounds.url,
      keptWant: keptSounds.want,
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
    .innerJoin(chapters, and(eq(chapters.bookId, clips.bookId), eq(chapters.id, clips.chapterId)))
    .leftJoin(keptSounds, and(eq(keptSounds.bookId, clips.bookId), eq(keptSounds.url, clips.url)))
    .where(
      and(
        eq(clips.bookId, bookId),
        inArray(clips.role, ["current", "candidate"]),
        eq(clips.status, "done"),
        isNotNull(clips.url),
        sql`coalesce(${chapters.excluded}, 0) = 0`,
        scope.speaker != null ? eq(segments.speaker, scope.speaker) : undefined,
      ),
    )
    .orderBy(asc(clips.chapterId))
    .all();
  const within = scope.chapters && new Set(scope.chapters);
  const known = new Map<string, Pick<StaleClip, "effects" | "want">>();
  const out: StaleClip[] = [];
  for (const { type, speaker, lineEffects, url, kept, keptWant, ...r } of rows) {
    if (within && !within.has(r.chapterId)) continue;
    const key = JSON.stringify([type === "thought", speaker, lineEffects]);
    let line = known.get(key);
    if (!line) {
      const effects = chainsFor({ type, speaker, effects: lineEffects ?? undefined }, ctx);
      line = { effects, want: soundOf(effects) };
      known.set(key, line);
    }
    if (r.sound === line.want || (kept != null && keptWant === line.want)) continue;
    out.push({ ...r, url: url!, ...line });
  }
  return out;
}

export function staleSound(
  db: Db | Tx,
  bookId: string,
  scope: ExistingScope = {},
): Omit<StaleSound, "ready"> {
  const stale = staleClips(db, bookId, scope);
  const byChapter: ExistingChapter[] = [];
  let unavailable = 0;
  // `staleClips` comes in chapter order, so one chapter's clips are together
  for (const c of stale) {
    let ch = byChapter.at(-1);
    if (ch?.id !== c.chapterId)
      byChapter.push((ch = { id: c.chapterId, lines: 0, unavailable: 0 }));
    ch.lines++;
    if (cannotRedo(c)) {
      ch.unavailable!++;
      unavailable++;
    }
  }
  return { lines: stale.length, unavailable, chapters: byChapter };
}

/**
 * Marks the stale clips in `scope` as kept against what their lines want now, so they stop being
 * stale until that changes. Returns how many.
 */
export function keepOldSound(db: Db, bookId: string, scope: ExistingScope): number {
  return db.transaction((tx) => {
    const stale = staleClips(tx, bookId, scope);
    // 3 variables a row, well under SQLite's limit
    for (let i = 0; i < stale.length; i += 500)
      tx.insert(keptSounds)
        .values(stale.slice(i, i + 500).map((c) => ({ bookId, url: c.url, want: c.want })))
        .onConflictDoUpdate({
          target: [keptSounds.bookId, keptSounds.url],
          set: { want: sql`excluded.want` },
        })
        .run();
    return stale.length;
  });
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
  // neither file is kept any more: one is gone, the other has the sound its line wants
  tx.delete(keptSounds)
    .where(and(eq(keptSounds.bookId, bookId), inArray(keptSounds.url, [was, next.url])))
    .run();
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
