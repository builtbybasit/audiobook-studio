// Every read and write a book's cast and pronunciation dictionary make.
//
// Both belong to the book. A speaker is keyed by name because the script refers to a speaker by
// name and nothing else, so renaming one is a key change that has to move the lines with it —
// that half lives in `server/db/script.ts` (`reattribute`) and the operations in
// `server/cast/ops.ts` do the two together in one transaction.
import { and, asc, eq, max } from "drizzle-orm";

import type { Character, LexEntry } from "@/types";
import { NARRATOR, narrator, newSpeaker } from "@/lib/cast";
import type { PromptCastMember } from "@/lib/prompt";
import type { Db, Tx } from "~/db/client";
import { characters, lexiconEntries } from "~/db/schema";
import { characterValues, lexiconValues, toCharacter, toLexEntry } from "~/db/rows";

export function readCast(db: Db | Tx, bookId: string): Character[] {
  return db
    .select()
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .orderBy(asc(characters.position), asc(characters.name))
    .all()
    .map(toCharacter);
}

/**
 * The speakers the book already has, as the prompt's cast tags read them, so a chunk read on its
 * own still calls Mara "Mara". A scripting run and a prompt trial both send it.
 */
export function readSpeakers(db: Db | Tx, bookId: string): PromptCastMember[] {
  return db
    .select({
      name: characters.name,
      aliases: characters.aliases,
      gender: characters.gender,
      description: characters.description,
    })
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .all();
}

export function getCharacter(db: Db | Tx, bookId: string, name: string): Character | undefined {
  const row = db
    .select()
    .from(characters)
    .where(and(eq(characters.bookId, bookId), eq(characters.name, name)))
    .get();
  return row ? toCharacter(row) : undefined;
}

function nextPosition(db: Db | Tx, bookId: string): number {
  return (
    (db
      .select({ n: max(characters.position) })
      .from(characters)
      .where(eq(characters.bookId, bookId))
      .get()?.n ?? -1) + 1
  );
}

/** Write one speaker: a new one goes on the end of the cast, an existing one keeps its place. */
export function upsertCharacter(db: Db | Tx, bookId: string, c: Character): void {
  const existing = db
    .select({ position: characters.position })
    .from(characters)
    .where(and(eq(characters.bookId, bookId), eq(characters.name, c.name)))
    .get();
  const values = characterValues(bookId, c, existing?.position ?? nextPosition(db, bookId));
  if (existing)
    db.update(characters)
      .set(values)
      .where(and(eq(characters.bookId, bookId), eq(characters.name, c.name)))
      .run();
  else db.insert(characters).values(values).run();
}

/** Change a speaker's name. The lines that name them are `reattribute`'s to move. */
export function renameCharacterRow(db: Db | Tx, bookId: string, from: string, to: string): void {
  db.update(characters)
    .set({ name: to, isNew: null })
    .where(and(eq(characters.bookId, bookId), eq(characters.name, from)))
    .run();
}

export function deleteCharacterRow(db: Db | Tx, bookId: string, name: string): boolean {
  return (
    db
      .delete(characters)
      .where(and(eq(characters.bookId, bookId), eq(characters.name, name)))
      .returning({ name: characters.name })
      .all().length > 0
  );
}

/**
 * Add any speaker in `names` the cast does not have yet, and say which were added.
 *
 * What a scripting job does with the speakers it turned up, in the transaction that writes the
 * script. A walk-on arrives as `newSpeaker` — unreviewed, so the Cast page can merge it — except
 * the Narrator, who every book has and who arrives as the main cast rather than as a stranger.
 */
export function ensureSpeakers(db: Db | Tx, bookId: string, names: Iterable<string>): string[] {
  const have = new Set(readCast(db, bookId).map((c) => c.name));
  const added: string[] = [];
  for (const name of new Set(names)) {
    if (have.has(name)) continue;
    const position = have.size;
    const c = name === NARRATOR ? narrator() : newSpeaker(name, position);
    db.insert(characters)
      .values(characterValues(bookId, c, position))
      .run();
    have.add(name);
    added.push(name);
  }
  return added;
}

/**
 * Fill in what a scripting model learnt of the book's speakers — gender, other names, a
 * description — where the cast has nothing yet, and say whose entries changed.
 *
 * It never overwrites: a gender or description a person set, or an earlier chapter brought, stands,
 * and other names are only ever added. An alias another speaker already goes by, as a name or an
 * alias, stays theirs. A note on someone the cast does not have — mentioned, but never given a
 * line — is dropped, as is anything said of the Narrator.
 */
export function learnCast(
  db: Db | Tx,
  bookId: string,
  notes: readonly PromptCastMember[],
): string[] {
  const cast = readCast(db, bookId);
  const byName = new Map(cast.map((c) => [c.name, c]));
  const taken = new Set(cast.flatMap((c) => [c.name, ...c.aliases]).map((n) => n.toLowerCase()));
  const changed = new Set<string>();
  for (const note of notes) {
    const c = byName.get(note.name);
    if (!c || c.name === NARRATOR) continue;
    let touched = false;
    if (c.gender === "?" && note.gender && note.gender !== "?") {
      c.gender = note.gender;
      touched = true;
    }
    if (!c.description.trim() && note.description?.trim()) {
      c.description = note.description.trim();
      touched = true;
    }
    for (const alias of note.aliases ?? []) {
      if (taken.has(alias.toLowerCase())) continue;
      c.aliases.push(alias);
      taken.add(alias.toLowerCase());
      touched = true;
    }
    if (!touched) continue;
    upsertCharacter(db, bookId, c);
    changed.add(c.name);
  }
  return [...changed];
}

// ---------- the pronunciation dictionary ----------

export function readLexicon(db: Db | Tx, bookId: string): LexEntry[] {
  return db
    .select()
    .from(lexiconEntries)
    .where(eq(lexiconEntries.bookId, bookId))
    .orderBy(asc(lexiconEntries.position))
    .all()
    .map(toLexEntry);
}

/**
 * The dictionary, replaced whole.
 *
 * It is a short list edited one entry at a time by a person, and the order it reads in is part of
 * it, so the whole list is the natural unit to write — and what an Undo of any change to it sends.
 */
export function replaceLexicon(db: Db | Tx, bookId: string, entries: readonly LexEntry[]): void {
  db.transaction((tx) => {
    tx.delete(lexiconEntries).where(eq(lexiconEntries.bookId, bookId)).run();
    entries.forEach((e, i) =>
      tx
        .insert(lexiconEntries)
        .values(lexiconValues(bookId, e, i))
        .run(),
    );
  });
}
