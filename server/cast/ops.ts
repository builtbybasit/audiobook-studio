// What a book's cast does, as operations.
//
// The same arrangement as `server/library/ops.ts`: a route turns a request into one of these and
// its result into JSON, and the rules live here. The rule that shapes this file is that a speaker
// is keyed by name and the script names speakers by name, so anything that changes a name — a
// rename, a merge, a removal — moves lines in every chapter of the book, and does so in the same
// transaction as the cast row. Each says which lines it moved, so an Undo can put exactly those
// back through `attribute` rather than guessing at an inverse.
import { and, asc, eq } from "drizzle-orm";

import type { Character, LexEntry, SegmentAudio } from "@/types";
import { NARRATOR } from "@/lib/cast";
import { speak } from "@/lib/speech";
import type { Db, Tx } from "~/db/client";
import * as cast from "~/db/cast";
import { chapters } from "~/db/schema";
import {
  attributeLines,
  bumpRevision,
  readScript,
  reattribute,
  writeClip,
  type ChapterLines,
  type MovedLines,
} from "~/db/script";
import { settleChapter } from "~/jobs/narration";
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

/** The dictionary as it now stands, and the clips it moved, by chapter with the revision now. */
export interface LexiconSaved {
  entries: LexEntry[];
  stale: MovedLines[];
  restored: MovedLines[];
}

/**
 * The pronunciation dictionary, replaced whole, and the clips it changes the words of.
 *
 * A clip records what the dictionary made of its line when it was sent (`pronounced`), so a clip
 * whose line the new list would send differently no longer says what the book would, and is marked
 * stale — the cast store's `_lexRestale`, in the same transaction as the list. `restore` is the
 * inverse an Undo sends: the lines an earlier change staled, put back to `done` where the list in
 * this request sends exactly what their clip was sent. A clip is not put back because it merely
 * could be: a clip stale by a rename has words the dictionary would still send, and is not this
 * request's to clear. So only the lines the Undo names are looked at — the ones the change it
 * undoes reported, as `attribute` trusts the lines a merge reported — and each only if its text is
 * still the text it was rendered from.
 */
export function putLexicon(
  db: Db,
  bookId: string,
  entries: readonly LexEntry[],
  restore: readonly ChapterLines[] = [],
): LexiconSaved {
  requireBook(db, bookId);
  const ids = new Set<number>();
  for (const e of entries) {
    if (ids.has(e.id)) throw badRequest(`Entry ${e.id} appears twice`);
    ids.add(e.id);
  }
  return db.transaction((tx) => {
    cast.replaceLexicon(tx, bookId, entries);
    const lexicon = cast.readLexicon(tx, bookId);
    const named = new Map(restore.map((r) => [r.chapterId, new Set(r.ids)]));
    const stale: MovedLines[] = [];
    const restored: MovedLines[] = [];
    for (const chapterId of chapterIds(tx, bookId)) {
      const staled: number[] = [];
      const back: number[] = [];
      const undo = named.get(chapterId);
      for (const s of readScript(tx, bookId, chapterId)) {
        const a = s.audio;
        const sent = a.pronounced ?? a.said ?? a.text;
        if (sent == null) continue;
        const now = speak(s.text, lexicon).text;
        let status: SegmentAudio["status"] | null = null;
        if (a.status === "done" && now !== sent) status = "stale";
        else if (a.status === "stale" && undo?.has(s.id) && a.text === s.text && now === sent)
          status = "done";
        if (!status) continue;
        writeClip(tx, bookId, chapterId, s.id, "current", { ...a, status });
        (status === "stale" ? staled : back).push(s.id);
      }
      if (!staled.length && !back.length) continue;
      const revision = bumpRevision(tx, bookId, chapterId);
      // a chapter a run is working through is the run's to add up when it finishes
      if (!inProgress(tx, bookId, chapterId)) settleChapter(tx, bookId, chapterId);
      if (staled.length) stale.push({ chapterId, ids: staled, revision });
      if (back.length) restored.push({ chapterId, ids: back, revision });
    }
    return { entries: lexicon, stale, restored };
  });
}

function chapterIds(tx: Tx, bookId: string): number[] {
  return tx
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.id))
    .all()
    .map((c) => c.id);
}

function inProgress(tx: Tx, bookId: string, chapterId: number): boolean {
  const row = tx
    .select({ narration: chapters.narration })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  return row?.narration === "queued" || row?.narration === "running";
}
