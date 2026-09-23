// Every read and write a book's cast and pronunciation dictionary make.
//
// Both belong to the book. A speaker is keyed by name because the script refers to a speaker by
// name and nothing else, so renaming one is a key change that has to move the lines with it —
// that half lives in `server/db/script.ts` (`reattribute`) and the operations in
// `server/cast/ops.ts` do the two together in one transaction.
import { and, asc, eq, max } from "drizzle-orm";

import type { Character, LexEntry } from "@/types";
import { NARRATOR, narrator, newSpeaker } from "@/lib/cast";
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
