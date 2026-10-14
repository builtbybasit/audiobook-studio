// A book's cast operations. Speakers are keyed by name and the script names them, so a rename,
// merge or removal moves lines in the same transaction as the cast row, and reports which lines
// moved so an Undo can put exactly those back through `attribute`.
import type {
  Cast,
  ChapterLines,
  Character,
  LexEntry,
  LexiconSaved,
  MovedLines,
  RevisedLines,
  SegmentAudio,
} from "@/types";
import { NARRATOR, personaRefusal } from "@/lib/cast";
import { pronunciationMoved } from "@/lib/reading";
import { speak } from "@/lib/speech";
import type { Db } from "~/db/client";
import * as cast from "~/db/cast";
import * as library from "~/db/library";
import { discardSpeakerSamples, moveSpeakerSamples } from "~/db/speakerSamples";
import { attributeLines, bumpRevision, readScript, reattribute, writeClip } from "~/db/script";
import { isEffectChoice, requireEffect } from "~/effects/ops";
import { badRequest, conflict, notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";
import { narrationInProgress, settleChapter } from "~/narration/chapter";

export function bookCast(db: Db, bookId: string): Cast {
  requireBook(db, bookId);
  return { characters: cast.readCast(db, bookId), lexicon: cast.readLexicon(db, bookId) };
}

function requireCharacter(db: Db, bookId: string, name: string): Character {
  const c = cast.getCharacter(db, bookId, name);
  if (!c) throw notFound(`“${name}” is not in this book’s cast`);
  return c;
}

function requireEffects(db: Db, c: Character): void {
  requireEffect(db, c.effect, `${c.name}’s effect`);
  requireEffect(db, c.thoughts, `${c.name}’s thought effect`);
}

/**
 * Insert or replace a speaker, for every edit that moves no lines. The persona link is checked only
 * when it changes, so an existing link never blocks an edit.
 */
export function putCharacter(db: Db, bookId: string, name: string, c: Character): Character[] {
  requireBook(db, bookId);
  if (c.name !== name) throw badRequest("The speaker in the body is not the one in the path");
  requireEffects(db, c);
  const was = cast.getCharacter(db, bookId, name);
  if (c.personaOf && c.personaOf !== was?.personaOf) {
    const why = personaRefusal(name, c.personaOf, cast.readCast(db, bookId));
    if (why) throw badRequest(why);
  }
  // a human changed the persona link, so the model's `masked` finding no longer applies
  if (was && (c.personaOf ?? null) !== (was.personaOf ?? null)) delete c.masked;
  cast.upsertCharacter(db, bookId, c);
  return cast.readCast(db, bookId);
}

/** Rename a speaker, moving their lines and personas. The Narrator's name is fixed. */
export function renameCharacter(db: Db, bookId: string, from: string, to: string): MovedLines {
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
    cast.relinkPersonas(tx, bookId, from, to);
    const moved = reattribute(tx, bookId, from, to);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/**
 * Fold `from` into `into`: lines move and `from` with its aliases becomes aliases. Personas of
 * `from` move to `into`, or are unlinked when `into` is a persona or the Narrator (no chains).
 */
export function mergeCharacter(db: Db, bookId: string, from: string, into: string): MovedLines {
  requireBook(db, bookId);
  if (from === NARRATOR)
    throw conflict(
      "The Narrator cannot be merged into another speaker",
      "Merge the other speaker into the Narrator instead.",
    );
  const src = requireCharacter(db, bookId, from);
  const dst = requireCharacter(db, bookId, into);
  if (from === into) throw badRequest("A speaker cannot be merged into themselves");
  // `into` was a persona of `from`: it can't be a persona of itself
  const personaOf = dst.personaOf === from ? undefined : dst.personaOf;
  return db.transaction((tx) => {
    cast.upsertCharacter(tx, bookId, {
      ...dst,
      aliases: [...new Set([...dst.aliases, from, ...src.aliases])],
      personaOf,
    });
    moveSpeakerSamples(tx, bookId, from, into);
    cast.deleteCharacterRow(tx, bookId, from);
    cast.relinkPersonas(tx, bookId, from, personaOf || into === NARRATOR ? null : into);
    const moved = reattribute(tx, bookId, from, into);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/** Remove a speaker; their lines go to the Narrator and their personas are unlinked. */
export function deleteCharacter(db: Db, bookId: string, name: string): MovedLines {
  requireBook(db, bookId);
  if (name === NARRATOR) throw conflict("The Narrator cannot be removed");
  requireCharacter(db, bookId, name);
  return db.transaction((tx) => {
    cast.ensureSpeakers(tx, bookId, [NARRATOR]);
    discardSpeakerSamples(tx, bookId, name, NARRATOR);
    cast.deleteCharacterRow(tx, bookId, name);
    cast.relinkPersonas(tx, bookId, name, null);
    const moved = reattribute(tx, bookId, name, NARRATOR);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/** The Undo of a merge or removal: put the speaker back on exactly these lines, as stated. */
export function attribute(
  db: Db,
  bookId: string,
  character: Character,
  lines: readonly ChapterLines[],
): MovedLines {
  requireBook(db, bookId);
  // drop an effect removed since or a persona link no longer allowed, rather than refuse the Undo
  const known = (id?: string) => (id && isEffectChoice(db, id) ? id : undefined);
  const others = cast.readCast(db, bookId).filter((c) => c.name !== character.name);
  const of = character.personaOf;
  character = {
    ...character,
    effect: known(character.effect),
    thoughts: known(character.thoughts),
    personaOf: of && !personaRefusal(character.name, of, others) ? of : undefined,
  };
  return db.transaction((tx) => {
    cast.upsertCharacter(tx, bookId, character);
    const moved = attributeLines(tx, bookId, lines, character.name);
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/**
 * Replace the pronunciation dictionary, marking stale each done clip it would now send differently.
 * `restore` (an Undo) puts back to `done` only the lines it names, and only when their text is
 * unchanged: a clip stale for another reason is not this request's to clear.
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
    const stale: RevisedLines[] = [];
    const restored: RevisedLines[] = [];
    for (const chapterId of library.chapterIds(tx, bookId)) {
      const staled: number[] = [];
      const back: number[] = [];
      const undo = named.get(chapterId);
      for (const s of readScript(tx, bookId, chapterId)) {
        const a = s.audio;
        const moved = pronunciationMoved(a, speak(s.text, lexicon).text);
        if (moved == null) continue;
        let status: SegmentAudio["status"] | null = null;
        if (a.status === "done" && moved) status = "stale";
        else if (a.status === "stale" && undo?.has(s.id) && a.text === s.text && !moved)
          status = "done";
        if (!status) continue;
        writeClip(tx, bookId, chapterId, s.id, "current", { ...a, status });
        (status === "stale" ? staled : back).push(s.id);
      }
      if (!staled.length && !back.length) continue;
      const revision = bumpRevision(tx, bookId, chapterId);
      // a running narration settles its chapter when it finishes
      if (!narrationInProgress(tx, bookId, chapterId)) settleChapter(tx, bookId, chapterId);
      if (staled.length) stale.push({ chapterId, ids: staled, revision });
      if (back.length) restored.push({ chapterId, ids: back, revision });
    }
    return { entries: lexicon, stale, restored };
  });
}
