// Speakers' facts and the profiles written from them. A profile is stale when facts newer than
// `profile_up_to` exist or `profile_rebuild` is set (facts went away: start over).
import { and, asc, eq, gt, inArray, max, or } from "drizzle-orm";

import type { Age, CastFact, CharacterProfile, FactKind, VoiceType } from "@/types";
import type { Db, Tx } from "~/db/client";
import { characterFacts, characters } from "~/db/schema";

export interface NewFact {
  speaker: string;
  kind: FactKind;
  text: string;
  evidence?: string;
  sourceIds?: number[];
}

const toFact = (r: typeof characterFacts.$inferSelect): CastFact => ({
  id: r.id,
  speaker: r.speaker,
  kind: r.kind,
  text: r.text,
  chapterId: r.chapterId,
  ...(r.evidence ? { evidence: r.evidence } : {}),
  ...(r.sourceIds ? { sourceIds: r.sourceIds } : {}),
});

/**
 * What makes two of a speaker's facts the same: kind and text, ignoring case, the final stop and a
 * leading name, alias or pronoun ("Cassia is blind." = "She is blind"). Exact otherwise.
 */
export function factKey(f: Pick<CastFact, "kind" | "text">, names: readonly string[]): string {
  let text = f.text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
  const name = [...names]
    .map((n) => n.toLowerCase())
    .sort((a, b) => b.length - a.length)
    .find((n) => text.startsWith(`${n} `));
  if (name) text = text.slice(name.length + 1);
  return `${f.kind}\n${text.replace(/^(he|she|they|it) /, "")}`;
}

/** Each fact once, in reading order: the first of its repeats, with `copies` when it has some. */
export function uniqueFacts(facts: readonly CastFact[], names: readonly string[]): CastFact[] {
  const first = new Map<string, CastFact>();
  for (const f of facts) {
    const k = factKey(f, names);
    const had = first.get(k);
    if (had) had.copies = (had.copies ?? 1) + 1;
    else first.set(k, { ...f });
  }
  return [...first.values()];
}

const markRebuild = (db: Db | Tx, bookId: string, names: readonly string[]): void => {
  if (!names.length) return;
  db.update(characters)
    .set({ profileRebuild: true })
    .where(and(eq(characters.bookId, bookId), inArray(characters.name, [...names])))
    .run();
};

/**
 * One chapter's facts replaced by these (only `only`'s, when given); facts on names not in the cast
 * are dropped. Speakers who lost a fact the new set doesn't repeat get a rebuild. Returns how many
 * were saved.
 */
export function replaceChapterFacts(
  tx: Tx,
  bookId: string,
  chapterId: number,
  facts: readonly NewFact[],
  only?: readonly string[],
): number {
  if (only && !only.length) return 0;
  const where = and(
    eq(characterFacts.bookId, bookId),
    eq(characterFacts.chapterId, chapterId),
    only ? inArray(characterFacts.speaker, [...only]) : undefined,
  );
  if (only) facts = facts.filter((f) => only.includes(f.speaker));
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
    ([, f]) => ({
      bookId,
      chapterId,
      speaker: f.speaker,
      kind: f.kind,
      text: f.text,
      evidence: f.evidence ?? null,
      sourceIds: f.sourceIds ?? null,
    }),
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

/** Changed facts, including removal of every fact, need a rebuild. Legacy profiles otherwise stand. */
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

export type ProfileRow = Pick<
  typeof characters.$inferSelect,
  | "name"
  | "aliases"
  | "gender"
  | "age"
  | "voiceType"
  | "profile"
  | "profileUpTo"
  | "profileRebuild"
  | "edited"
  | "personaOf"
  | "masked"
>;

/** What a profile rewrite reads of these speakers. */
export function profileRows(db: Db | Tx, bookId: string, names: readonly string[]): ProfileRow[] {
  if (!names.length) return [];
  return db
    .select({
      name: characters.name,
      aliases: characters.aliases,
      gender: characters.gender,
      age: characters.age,
      voiceType: characters.voiceType,
      profile: characters.profile,
      profileUpTo: characters.profileUpTo,
      profileRebuild: characters.profileRebuild,
      edited: characters.edited,
      personaOf: characters.personaOf,
      masked: characters.masked,
    })
    .from(characters)
    .where(and(eq(characters.bookId, bookId), inArray(characters.name, [...names])))
    .all();
}

/** Save only against the evidence and profile read before the model request. */
export function setProfile(
  db: Db,
  bookId: string,
  expected: ProfileRow,
  facts: readonly CastFact[],
  profile: CharacterProfile | null,
  upTo: number,
  /** left out: kept as they are */
  tags: { age?: Age; voiceType?: VoiceType } = {},
): boolean {
  return db.transaction((tx) => {
    const current = profileRows(tx, bookId, [expected.name])[0];
    // This also catches deletion, renaming, a new persona link, and a competing rewrite.
    if (
      !current ||
      !Bun.deepEquals(current, expected) ||
      !Bun.deepEquals(readFacts(tx, bookId, expected.name), facts)
    )
      return false;
    tx.update(characters)
      .set({
        profile,
        profileUpTo: upTo,
        profileRebuild: false,
        ...(tags.age && !current.edited.includes("age") ? { age: tags.age } : {}),
        ...(tags.voiceType && !current.edited.includes("voiceType")
          ? { voiceType: tags.voiceType }
          : {}),
      })
      .where(and(eq(characters.bookId, bookId), eq(characters.name, expected.name)))
      .run();
    return true;
  });
}

/** Whose fact it was, with its repeats in other chapters gone too; undefined when there was none. */
export function deleteFact(db: Db, bookId: string, id: number): string | undefined {
  return db.transaction((tx) => {
    const fact = tx
      .select()
      .from(characterFacts)
      .where(and(eq(characterFacts.bookId, bookId), eq(characterFacts.id, id)))
      .get();
    if (!fact) return undefined;
    const { speaker } = fact;
    const c = profileRows(tx, bookId, [speaker])[0];
    const names = [speaker, ...(c?.aliases ?? [])];
    const copies = readFacts(tx, bookId, speaker)
      .filter((f) => factKey(f, names) === factKey(fact, names))
      .map((f) => f.id);
    tx.delete(characterFacts).where(inArray(characterFacts.id, copies)).run();
    markRebuild(tx, bookId, [speaker]);
    // the tags stay: the scripting notes may have given them
    if (c && !readFacts(tx, bookId, speaker).length)
      tx.update(characters)
        .set({ profile: null, profileUpTo: 0, profileRebuild: false })
        .where(and(eq(characters.bookId, bookId), eq(characters.name, speaker)))
        .run();
    return speaker;
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
