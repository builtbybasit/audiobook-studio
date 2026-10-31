// Speakers' facts and the profiles written from them. A profile is stale when facts newer than
// `profile_up_to` exist or `profile_rebuild` is set (facts went away: start over). A `known` fact
// adds nothing a profile needs and is never folded; a repeat stands only while what it repeats does.
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
  known?: true;
}

const toFact = (r: typeof characterFacts.$inferSelect): CastFact => ({
  id: r.id,
  speaker: r.speaker,
  kind: r.kind,
  text: r.text,
  chapterId: r.chapterId,
  ...(r.evidence ? { evidence: r.evidence } : {}),
  ...(r.sourceIds ? { sourceIds: r.sourceIds } : {}),
  ...(r.known ? { known: true as const } : {}),
  ...(r.repeatOf != null ? { repeatOf: r.repeatOf } : {}),
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
 * are dropped. Speakers who lost a fact the new set doesn't repeat get a rebuild, and so do those
 * whose repeats of a removed fact come back. Returns how many were saved.
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
  tx.delete(characterFacts).where(where).run();
  const revived = old.length
    ? tx
        .update(characterFacts)
        .set({ known: false, repeatOf: null })
        .where(
          and(
            eq(characterFacts.bookId, bookId),
            inArray(
              characterFacts.repeatOf,
              old.map((f) => f.id),
            ),
          ),
        )
        .returning({ speaker: characterFacts.speaker })
        .all()
    : [];
  markRebuild(tx, bookId, [
    ...new Set([
      ...old.filter((f) => !kept.has(key(f))).map((f) => f.speaker),
      ...revived.map((f) => f.speaker),
    ]),
  ]);
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
      known: f.known ?? false,
    }),
  );
  if (rows.length) tx.insert(characterFacts).values(rows).run();
  return rows.length;
}

/** In reading order; `live`: only those not `known`. */
export function readFacts(
  db: Db | Tx,
  bookId: string,
  speaker: string,
  { live = false } = {},
): CastFact[] {
  return db
    .select()
    .from(characterFacts)
    .where(
      and(
        eq(characterFacts.bookId, bookId),
        eq(characterFacts.speaker, speaker),
        live ? eq(characterFacts.known, false) : undefined,
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

/**
 * These facts marked as adding nothing, each `repeatOf` the fact it says again. A fact others
 * repeat stays live, or what they say would reach no rebuild.
 */
function markKnown(tx: Tx, marks: readonly { id: number; repeatOf?: number }[]): void {
  if (!marks.length) return;
  const repeated = new Set([
    ...marks.flatMap((m) => (m.repeatOf ? [m.repeatOf] : [])),
    ...tx
      .select({ of: characterFacts.repeatOf })
      .from(characterFacts)
      .where(
        inArray(
          characterFacts.repeatOf,
          marks.map((m) => m.id),
        ),
      )
      .all()
      .map((r) => r.of),
  ]);
  for (const { id, repeatOf } of marks.filter((m) => !repeated.has(m.id)))
    tx.update(characterFacts)
      .set({ known: true, ...(repeatOf ? { repeatOf } : {}) })
      .where(eq(characterFacts.id, id))
      .run();
}

/**
 * Save only against the live facts and profile read before the model request, marking `known`
 * among those facts.
 */
export function setProfile(
  db: Db,
  bookId: string,
  expected: ProfileRow,
  facts: readonly CastFact[],
  profile: CharacterProfile | null,
  upTo: number,
  /** left out: kept as they are */
  tags: { age?: Age; voiceType?: VoiceType } = {},
  known: readonly number[] = [],
): boolean {
  return db.transaction((tx) => {
    const current = profileRows(tx, bookId, [expected.name])[0];
    // This also catches deletion, renaming, a new persona link, and a competing rewrite.
    if (
      !current ||
      !Bun.deepEquals(current, expected) ||
      !Bun.deepEquals(readFacts(tx, bookId, expected.name, { live: true }), facts)
    )
      return false;
    markKnown(
      tx,
      known.map((id) => ({ id })),
    );
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

/** Marks a compaction found, kept only if the speaker's live facts are still those it read. */
export function markCompacted(
  db: Db,
  bookId: string,
  speaker: string,
  facts: readonly CastFact[],
  marks: readonly { id: number; repeatOf?: number }[],
): boolean {
  return db.transaction((tx) => {
    if (!Bun.deepEquals(readFacts(tx, bookId, speaker, { live: true }), facts)) return false;
    markKnown(tx, marks);
    return true;
  });
}

/**
 * Whose fact it was, with its copies in other chapters and what repeats them gone too; undefined
 * when there was none.
 */
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
    const all = readFacts(tx, bookId, speaker);
    const gone = new Set(
      all.filter((f) => factKey(f, names) === factKey(fact, names)).map((f) => f.id),
    );
    // a repeat may be repeated in turn
    for (let more = true; more;) {
      more = false;
      for (const f of all)
        if (f.repeatOf && gone.has(f.repeatOf) && !gone.has(f.id)) {
          gone.add(f.id);
          more = true;
        }
    }
    tx.delete(characterFacts)
      .where(inArray(characterFacts.id, [...gone]))
      .run();
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
