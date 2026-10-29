// Speakers' facts and the profiles written from them. A profile is stale when facts newer than
// `profile_up_to` exist (fold them in) or `profile_rebuild` is set (facts went away: start over).
import { and, asc, eq, gt, inArray, max, or } from "drizzle-orm";

import type { CastFact, CharacterProfile, FactKind } from "@/types";
import type { Db, Tx } from "~/db/client";
import { characterFacts, characters } from "~/db/schema";

export interface NewFact {
  speaker: string;
  kind: FactKind;
  text: string;
}

const toFact = (r: typeof characterFacts.$inferSelect): CastFact => ({
  id: r.id,
  speaker: r.speaker,
  kind: r.kind,
  text: r.text,
});

const markRebuild = (db: Db | Tx, bookId: string, names: readonly string[]): void => {
  if (!names.length) return;
  db.update(characters)
    .set({ profileRebuild: true })
    .where(and(eq(characters.bookId, bookId), inArray(characters.name, [...names])))
    .run();
};

/**
 * One chapter's facts replaced by these; facts on names not in the cast are dropped. Speakers who
 * lost a fact the new set doesn't repeat get a rebuild. Returns how many were saved.
 */
export function replaceChapterFacts(
  tx: Tx,
  bookId: string,
  chapterId: number,
  facts: readonly NewFact[],
): number {
  const where = and(eq(characterFacts.bookId, bookId), eq(characterFacts.chapterId, chapterId));
  const old = tx.select().from(characterFacts).where(where).all();
  const key = (f: { speaker: string; kind: string; text: string }) =>
    `${f.speaker}\n${f.kind}\n${f.text.toLowerCase()}`;
  const kept = new Set(facts.map(key));
  markRebuild(tx, bookId, [...new Set(old.filter((f) => !kept.has(key(f))).map((f) => f.speaker))]);
  tx.delete(characterFacts).where(where).run();
  const cast = new Set(
    tx
      .select({ name: characters.name })
      .from(characters)
      .where(eq(characters.bookId, bookId))
      .all()
      .map((c) => c.name),
  );
  const rows = [...new Map(facts.filter((f) => cast.has(f.speaker)).map((f) => [key(f), f]))].map(
    ([, f]) => ({ bookId, chapterId, speaker: f.speaker, kind: f.kind, text: f.text }),
  );
  if (rows.length) tx.insert(characterFacts).values(rows).run();
  return rows.length;
}

/** In reading order; `after` = only facts with a higher id. */
export function readFacts(db: Db | Tx, bookId: string, speaker: string, after = 0): CastFact[] {
  return db
    .select()
    .from(characterFacts)
    .where(
      and(
        eq(characterFacts.bookId, bookId),
        eq(characterFacts.speaker, speaker),
        gt(characterFacts.id, after),
      ),
    )
    .orderBy(asc(characterFacts.chapterId), asc(characterFacts.id))
    .all()
    .map(toFact);
}

/** Speakers whose profile is behind their facts, in cast order. */
export function staleSpeakers(db: Db | Tx, bookId: string): string[] {
  const newest = db
    .select({ speaker: characterFacts.speaker, top: max(characterFacts.id).as("top") })
    .from(characterFacts)
    .where(eq(characterFacts.bookId, bookId))
    .groupBy(characterFacts.speaker)
    .as("newest");
  return db
    .select({ name: characters.name })
    .from(characters)
    .leftJoin(newest, eq(newest.speaker, characters.name))
    .where(
      and(
        eq(characters.bookId, bookId),
        or(eq(characters.profileRebuild, true), gt(newest.top, characters.profileUpTo)),
      ),
    )
    .orderBy(asc(characters.position))
    .all()
    .map((r) => r.name);
}

/** A rewrite's result; `upTo` is the newest fact id it read. Clears the rebuild mark. */
export function setProfile(
  db: Db | Tx,
  bookId: string,
  name: string,
  profile: CharacterProfile,
  upTo: number,
): void {
  db.update(characters)
    .set({ profile, profileUpTo: upTo, profileRebuild: false })
    .where(and(eq(characters.bookId, bookId), eq(characters.name, name)))
    .run();
}

/** False when there was no such fact. */
export function deleteFact(db: Db, bookId: string, id: number): boolean {
  return db.transaction((tx) => {
    const row = tx
      .delete(characterFacts)
      .where(and(eq(characterFacts.bookId, bookId), eq(characterFacts.id, id)))
      .returning({ speaker: characterFacts.speaker })
      .get();
    if (row) markRebuild(tx, bookId, [row.speaker]);
    return !!row;
  });
}

/** A merge: `from`'s facts become `to`'s, and `to` is rebuilt so they fold in reading order. */
export function moveFacts(tx: Tx, bookId: string, from: string, to: string): void {
  const moved = tx
    .update(characterFacts)
    .set({ speaker: to })
    .where(and(eq(characterFacts.bookId, bookId), eq(characterFacts.speaker, from)))
    .returning({ id: characterFacts.id })
    .all();
  if (moved.length) markRebuild(tx, bookId, [to]);
}

/** Start over: the facts go with the scripts they came from; profiles stay. */
export function clearBookFacts(tx: Tx, bookId: string): void {
  tx.delete(characterFacts).where(eq(characterFacts.bookId, bookId)).run();
}
