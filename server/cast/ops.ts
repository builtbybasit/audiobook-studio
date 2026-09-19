// What a book's cast does, as operations.
//
// The same arrangement as `server/library/ops.ts`: a route turns a request into one of these and
// its result into JSON, and the rules live here. The rule that shapes this file is that a speaker
// is keyed by name and the script names speakers by name, so anything that changes a name — a
// rename, a merge, a removal — moves lines in every chapter of the book, and does so in the same
// transaction as the cast row. Each says which lines it moved, so an Undo can put exactly those
// back through `attribute` rather than guessing at an inverse.
import type { Character, LexEntry } from "@/types";
import { NARRATOR } from "@/lib/cast";
import type { Db } from "~/db/client";
import * as cast from "~/db/cast";
import { attributeLines, reattribute, type ChapterLines, type MovedLines } from "~/db/script";
import { badRequest, conflict, notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";

export interface Cast {
  characters: Character[];
  lexicon: LexEntry[];
}

/** Lines that changed hands, by chapter with the chapter's revision now, and the cast as it stands. */
export interface Moved {
  characters: Character[];
  moved: MovedLines[];
}

export function bookCast(db: Db, bookId: string): Cast {
  requireBook(db, bookId);
  return { characters: cast.readCast(db, bookId), lexicon: cast.readLexicon(db, bookId) };
}

function requireCharacter(db: Db, bookId: string, name: string): Character {
  const c = cast.getCharacter(db, bookId, name);
  if (!c) throw notFound(`“${name}” is not in this book’s cast`);
  return c;
}

/**
 * Write one speaker as stated: a new one joins the cast, an existing one is replaced. Everything
 * about a speaker that moves no lines — gender, description, voice, delivery style, aliases, the
 * merge suggestion being dismissed — arrives this way.
 */
export function putCharacter(db: Db, bookId: string, name: string, c: Character): Character[] {
  requireBook(db, bookId);
  if (c.name !== name) throw badRequest("The speaker in the body is not the one in the path");
  cast.upsertCharacter(db, bookId, c);
  return cast.readCast(db, bookId);
}

/**
 * Change a speaker's name, and re-attribute every line that names them. Not the Narrator's: the
 * Narrator is the speaker every book has and every removal hands lines to, by that name.
 */
export function renameCharacter(db: Db, bookId: string, from: string, to: string): Moved {
  requireBook(db, bookId);
  to = to.trim();
  if (!to) throw badRequest("A speaker needs a name");
  if (from === NARRATOR) throw conflict("The Narrator cannot be renamed");
  requireCharacter(db, bookId, from);
  if (from === to) return { characters: cast.readCast(db, bookId), moved: [] };
  if (cast.getCharacter(db, bookId, to))
    throw conflict(`“${to}” is already in the cast`, "Merge the two speakers instead.");
  return db.transaction((tx) => {
    cast.renameCharacterRow(tx, bookId, from, to);
    const moved = reattribute(tx, bookId, from, to);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/**
 * Fold one speaker into another: the lines move, the name and its aliases become aliases of the
 * speaker that stays, and the speaker that went comes off the cast. Anyone can be folded into the
 * Narrator; the Narrator is folded into no one, for the reason they cannot be removed.
 */
export function mergeCharacter(db: Db, bookId: string, from: string, into: string): Moved {
  requireBook(db, bookId);
  if (from === NARRATOR)
    throw conflict(
      "The Narrator cannot be merged into another speaker",
      "Merge the other speaker into the Narrator instead.",
    );
  const src = requireCharacter(db, bookId, from);
  const dst = requireCharacter(db, bookId, into);
  if (from === into) throw badRequest("A speaker cannot be merged into themselves");
  return db.transaction((tx) => {
    cast.upsertCharacter(tx, bookId, {
      ...dst,
      aliases: [...new Set([...dst.aliases, from, ...src.aliases])],
    });
    cast.deleteCharacterRow(tx, bookId, from);
    const moved = reattribute(tx, bookId, from, into);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/** Take a speaker off the cast; the lines they read go to the Narrator. */
export function deleteCharacter(db: Db, bookId: string, name: string): Moved {
  requireBook(db, bookId);
  if (name === NARRATOR) throw conflict("The Narrator cannot be removed");
  requireCharacter(db, bookId, name);
  return db.transaction((tx) => {
    cast.ensureSpeakers(tx, bookId, [NARRATOR]);
    cast.deleteCharacterRow(tx, bookId, name);
    const moved = reattribute(tx, bookId, name, NARRATOR);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/**
 * Put a speaker back on exactly these lines, and back in the cast if they are gone: what an Undo
 * of a merge or a removal sends. The rules above only run forwards — a merge folds aliases in and
 * cannot be told apart from ones that were already there — so an undo records what moved and puts
 * that back as stated.
 */
export function attribute(
  db: Db,
  bookId: string,
  character: Character,
  lines: readonly ChapterLines[],
): Moved {
  requireBook(db, bookId);
  return db.transaction((tx) => {
    cast.upsertCharacter(tx, bookId, character);
    const moved = attributeLines(tx, bookId, lines, character.name);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/** The pronunciation dictionary, replaced whole. */
export function putLexicon(db: Db, bookId: string, entries: readonly LexEntry[]): LexEntry[] {
  requireBook(db, bookId);
  const ids = new Set<number>();
  for (const e of entries) {
    if (ids.has(e.id)) throw badRequest(`Entry ${e.id} appears twice`);
    ids.add(e.id);
  }
  cast.replaceLexicon(db, bookId, entries);
  return cast.readLexicon(db, bookId);
}
