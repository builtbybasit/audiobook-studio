// A book's cast operations. Speakers are keyed by name and the script names them, so a rename,
// merge or removal moves lines in the same transaction as the cast row, and reports which lines
// (and waiting voice samples) moved so an Undo can put exactly those back through `attribute`.
import type {
  Cast,
  ChapterLines,
  Character,
  LexEntry,
  LexiconSaved,
  MovedLines,
  MovedSpeakers,
  RevisedLines,
  SegmentAudio,
} from "@/types";
import { NARRATOR, personaRefusal, sameReading } from "@/lib/cast";
import { pronunciationMoved } from "@/lib/reading";
import { lexMatcher } from "@/lib/speech";
import type { Db, Tx } from "~/db/client";
import * as cast from "~/db/cast";
import * as library from "~/db/library";
import { discardSpeakerSamples, giveBackSamples, moveSpeakerSamples } from "~/db/speakerSamples";
import {
  attributeLines,
  bumpRevision,
  readScript,
  reattribute,
  writeClip,
  type ReadsAlike,
} from "~/db/script";
import { isEffectChoice, requireEffect } from "~/effects/ops";
import { badRequest, conflict, notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";
import { narrationInProgress, settleChapter } from "~/narration/chapter";

export function bookCast(db: Db, bookId: string): Cast {
  requireBook(db, bookId);
  return { characters: cast.readCast(db, bookId), lexicon: cast.readLexicon(db, bookId) };
}

export function requireCharacter(db: Db | Tx, bookId: string, name: string): Character {
  const c = cast.getCharacter(db, bookId, name);
  if (!c) throw notFound(`“${name}” is not in this book’s cast`);
  return c;
}

const castByName = (tx: Tx, bookId: string) =>
  new Map(cast.readCast(tx, bookId).map((c) => [c.name, c]));

/**
 * The stale rule for lines that change speaker along with the cast (`sameReading`): asked before
 * the cast changes, and settled once it reads as the moved lines will hear it.
 */
function readings(tx: Tx, bookId: string): () => ReadsAlike {
  const before = castByName(tx, bookId);
  const cv = library.getBook(tx, bookId)?.characterVoice;
  return () => {
    const after = castByName(tx, bookId);
    return (from, to) => sameReading(from, to, before, cv, after);
  };
}

/**
 * Insert or replace a speaker, for every edit that moves no lines. The persona link is checked only
 * when it changes, so an existing link never blocks an edit.
 */
function putOne(tx: Db | Tx, bookId: string, c: Character): void {
  requireEffect(tx, c.effect, `${c.name}’s effect`);
  requireEffect(tx, c.thoughts, `${c.name}’s thought effect`);
  const was = cast.getCharacter(tx, bookId, c.name);
  if (c.personaOf && c.personaOf !== was?.personaOf) {
    const why = personaRefusal(c.name, c.personaOf, cast.readCast(tx, bookId));
    if (why) throw badRequest(why);
  }
  // a human changed the persona link, so the model's `masked` finding no longer applies
  if (was && (c.personaOf ?? null) !== (was.personaOf ?? null)) delete c.masked;
  cast.upsertCharacter(tx, bookId, c);
}

export function putCharacter(db: Db, bookId: string, name: string, c: Character): Character[] {
  requireBook(db, bookId);
  if (c.name !== name) throw badRequest("The speaker in the body is not the one in the path");
  putOne(db, bookId, c);
  return cast.readCast(db, bookId);
}

/** `putCharacter` for several speakers in one go (auto-assign), all or nothing. */
export function putCharacters(db: Db, bookId: string, list: readonly Character[]): Character[] {
  requireBook(db, bookId);
  return db.transaction((tx) => {
    for (const c of list) putOne(tx, bookId, c);
    return cast.readCast(tx, bookId);
  });
}

/**
 * Rename a speaker, moving their lines and personas. The old name becomes an alias, so a re-script
 * that meets it in the text still means them. The Narrator's name is fixed.
 */
export function renameCharacter(db: Db, bookId: string, from: string, to: string): MovedLines {
  requireBook(db, bookId);
  to = to.trim();
  if (!to) throw badRequest("A speaker needs a name");
  if (from === NARRATOR) throw conflict("The Narrator cannot be renamed");
  const was = requireCharacter(db, bookId, from);
  if (from === to) return { characters: cast.readCast(db, bookId), moved: [] };
  if (cast.getCharacter(db, bookId, to))
    throw conflict(`“${to}” is already in the cast`, "Merge the two speakers instead.");
  return db.transaction((tx) => {
    const settle = readings(tx, bookId);
    cast.renameCharacterRow(tx, bookId, from, to);
    const aliases = [...new Set([...was.aliases, from])].filter((a) => a !== to);
    cast.upsertCharacter(tx, bookId, { ...requireCharacter(tx, bookId, to), aliases });
    cast.relinkPersonas(tx, bookId, from, to);
    const moved = reattribute(tx, bookId, from, to, settle());
    return { characters: cast.readCast(tx, bookId), moved };
  });
}

/**
 * Fold each `from` into its `into`, in order and all or nothing: lines and waiting voice samples
 * move, `from` with its aliases becomes aliases, and what `into` left blank `from` fills (not for
 * the Narrator, whose voice is every narration line's). Personas of `from` move to `into`, or are
 * unlinked when `into` is a persona or the Narrator (no chains).
 */
export function mergeCharacters(
  db: Db,
  bookId: string,
  merges: readonly { from: string; into: string }[],
): MovedSpeakers {
  requireBook(db, bookId);
  return db.transaction((tx) => {
    const speakers = merges.map(({ from, into }) => mergeOne(tx, bookId, from, into));
    return { characters: cast.readCast(tx, bookId), speakers };
  });
}

function mergeOne(
  tx: Tx,
  bookId: string,
  from: string,
  into: string,
): MovedSpeakers["speakers"][number] {
  if (from === NARRATOR)
    throw conflict(
      "The Narrator cannot be merged into another speaker",
      "Merge the other speaker into the Narrator instead.",
    );
  const src = requireCharacter(tx, bookId, from);
  const dst = requireCharacter(tx, bookId, into);
  if (from === into) throw badRequest("A speaker cannot be merged into themselves");
  const settle = readings(tx, bookId);
  // `into` was a persona of `from`: it can't be a persona of itself
  const personaOf = dst.personaOf === from ? undefined : dst.personaOf;
  const blanks =
    into === NARRATOR
      ? {}
      : {
          // a voiceless persona reads in their character's
          voice: dst.voice ?? (personaOf ? null : src.voice),
          effect: dst.effect ?? src.effect,
          thoughts: dst.thoughts ?? src.thoughts,
          speed: dst.speed ?? src.speed,
          description: dst.description.trim() ? dst.description : src.description,
          gender: dst.gender === "?" ? src.gender : dst.gender,
        };
  cast.upsertCharacter(tx, bookId, {
    ...dst,
    ...blanks,
    aliases: [...new Set([...dst.aliases, from, ...src.aliases])],
    personaOf,
  });
  const samples = moveSpeakerSamples(tx, bookId, from, into);
  cast.deleteCharacterRow(tx, bookId, from);
  cast.relinkPersonas(tx, bookId, from, personaOf || into === NARRATOR ? null : into);
  return { name: from, moved: reattribute(tx, bookId, from, into, settle()), samples };
}

/**
 * Remove speakers, all or nothing; their lines go to the Narrator, their personas are unlinked and
 * their waiting voice samples are put aside.
 */
export function removeCharacters(db: Db, bookId: string, names: readonly string[]): MovedSpeakers {
  requireBook(db, bookId);
  if (names.includes(NARRATOR)) throw conflict("The Narrator cannot be removed");
  return db.transaction((tx) => {
    cast.ensureSpeakers(tx, bookId, [NARRATOR]);
    const speakers = [...new Set(names)].map((name) => {
      requireCharacter(tx, bookId, name);
      const settle = readings(tx, bookId);
      const samples = discardSpeakerSamples(tx, bookId, name, NARRATOR);
      cast.deleteCharacterRow(tx, bookId, name);
      cast.relinkPersonas(tx, bookId, name, null);
      return { name, moved: reattribute(tx, bookId, name, NARRATOR, settle()), samples };
    });
    return { characters: cast.readCast(tx, bookId), speakers };
  });
}

/**
 * The Undo of a merge or removal: put each speaker back on exactly their lines and samples, as
 * stated. Links are checked once all are back, so a persona and its character can return together;
 * a link or effect no longer allowed is dropped rather than refusing the Undo.
 */
export function attribute(
  db: Db,
  bookId: string,
  restore: readonly { character: Character; lines: readonly ChapterLines[]; samples?: number[] }[],
): MovedSpeakers {
  requireBook(db, bookId);
  const known = (id?: string) => (id && isEffectChoice(db, id) ? id : undefined);
  return db.transaction((tx) => {
    const speakers = restore.map(({ character: c, lines, samples = [] }) => {
      const settle = readings(tx, bookId);
      cast.upsertCharacter(tx, bookId, {
        ...c,
        effect: known(c.effect),
        thoughts: known(c.thoughts),
      });
      giveBackSamples(tx, bookId, samples, c.name);
      return { name: c.name, moved: attributeLines(tx, bookId, lines, c.name, settle()) };
    });
    const now = cast.readCast(tx, bookId);
    for (const { character: c } of restore) {
      const others = now.filter((x) => x.name !== c.name);
      if (c.personaOf && personaRefusal(c.name, c.personaOf, others))
        cast.upsertCharacter(tx, bookId, {
          ...now.find((x) => x.name === c.name)!,
          personaOf: undefined,
        });
    }
    return { characters: cast.readCast(tx, bookId), speakers };
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
    const say = lexMatcher(lexicon);
    const named = new Map(restore.map((r) => [r.chapterId, new Set(r.ids)]));
    const stale: RevisedLines[] = [];
    const restored: RevisedLines[] = [];
    for (const chapterId of library.chapterIds(tx, bookId)) {
      const staled: number[] = [];
      const back: number[] = [];
      const undo = named.get(chapterId);
      for (const s of readScript(tx, bookId, chapterId)) {
        const a = s.audio;
        const moved = pronunciationMoved(a, say.speak(s.text).text);
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
