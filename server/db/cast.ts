// A book's cast and pronunciation dictionary. Speakers are keyed by name (the script refers to
// them by name only), so a rename must also move the lines: `reattribute` in server/db/script.ts,
// done together in server/cast/ops.ts.
import { and, asc, desc, eq, inArray, lt, max, sql } from "drizzle-orm";

import type { Character, LexEntry } from "@/types";
import {
  NARRATOR,
  chapterCast,
  narrator,
  newSpeaker,
  personaOwner,
  personaRefusal,
} from "@/lib/cast";
import type { PromptCastMember } from "@/lib/prompt";
import type { Db, Tx } from "~/db/client";
import { chapters, characters, lexiconEntries, segments } from "~/db/schema";
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
 * The cast as the prompt's cast tags read it, so a chunk on its own still calls Mara "Mara".
 * `personaOf` only when it resolves as narration links it (`personaOwner`).
 */
export function readSpeakers(db: Db | Tx, bookId: string): PromptCastMember[] {
  const rows = db
    .select({
      name: characters.name,
      aliases: characters.aliases,
      gender: characters.gender,
      description: characters.description,
      personaOf: characters.personaOf,
      masked: characters.masked,
    })
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .all();
  const byName = new Map(rows.map((r) => [r.name, r]));
  return rows.map(({ personaOf, masked, ...c }) => ({
    ...c,
    ...(personaOwner({ name: c.name, personaOf: personaOf ?? undefined }, byName)
      ? { personaOf: personaOf! }
      : {}),
    ...(masked ? { masked: true } : {}),
  }));
}

/** Kept chapters before one whose speakers may still be in the scene. */
const RECENT_CHAPTERS = 3;

/** The speakers a chapter's scripting prompt lists; rule in `chapterCast`. */
export function readChapterCast(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  text: string,
): PromptCastMember[] {
  const before = db
    .select({ id: chapters.id })
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        lt(chapters.id, chapterId),
        sql`coalesce(${chapters.excluded}, 0) = 0`,
      ),
    )
    .orderBy(desc(chapters.id))
    .limit(RECENT_CHAPTERS)
    .all()
    .map((c) => c.id);
  const recent = db
    .selectDistinct({ speaker: segments.speaker })
    .from(segments)
    .where(and(eq(segments.bookId, bookId), inArray(segments.chapterId, [chapterId, ...before])))
    .all()
    .map((s) => s.speaker);
  return chapterCast(readSpeakers(db, bookId), text, new Set(recent));
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

/** A new speaker goes on the end of the cast; an existing one keeps its place. */
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

/** The lines that name them are `reattribute`'s to move. */
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
 * Adds the speakers the cast lacks and returns them. A walk-on arrives unreviewed (`newSpeaker`),
 * so the Cast page can merge it; the Narrator arrives as main cast.
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
 * Fills blanks from the model's cast notes and returns whose entries changed. Never overwrites;
 * aliases are only added, and one another speaker already uses stays theirs. Notes on speakers not
 * in the cast, or on the Narrator, are dropped. A disguise is taken only for a `fresh` speaker or
 * one the model masked before, never one a person linked: "unknown" masks it, a wearer's name sets
 * `personaOf` (adding the wearer if missing) unless `personaRefusal` refuses.
 */
export function learnCast(
  db: Db | Tx,
  bookId: string,
  notes: readonly PromptCastMember[],
  fresh: ReadonlySet<string> = new Set(),
): string[] {
  const cast = readCast(db, bookId);
  const byName = new Map(cast.map((c) => [c.name, c]));
  const taken = new Set(cast.flatMap((c) => [c.name, ...c.aliases]).map((n) => n.toLowerCase()));
  const changed = new Map<string, Character>();
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
    const open = !c.personaOf && (fresh.has(c.name) || c.masked);
    if (open && note.personaOf) {
      if (!byName.has(note.personaOf)) {
        ensureSpeakers(db, bookId, [note.personaOf]);
        const added = getCharacter(db, bookId, note.personaOf)!;
        cast.push(added);
        byName.set(added.name, added);
      }
      const wearer = byName.get(note.personaOf);
      if (wearer && !personaRefusal(c.name, wearer.name, cast)) {
        c.personaOf = wearer.name;
        c.masked = true;
        touched = true;
        const kept = wearer.aliases.filter((a) => a.toLowerCase() !== c.name.toLowerCase());
        if (kept.length < wearer.aliases.length) {
          wearer.aliases = kept;
          changed.set(wearer.name, wearer);
        }
      }
    } else if (open && note.masked && !c.masked) {
      c.masked = true;
      touched = true;
    }
    if (touched) changed.set(c.name, c);
  }
  for (const c of changed.values()) upsertCharacter(db, bookId, c);
  return [...changed.keys()];
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

/** Replaced whole: it is short, its order matters, and Undo sends the whole list. */
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

// ---------- personas ----------

/** Repoint every persona of `from` at `to`, or unlink them when `to` is null. */

export function relinkPersonas(db: Db | Tx, bookId: string, from: string, to: string | null): void {
  db.update(characters)
    .set({ personaOf: to })
    .where(and(eq(characters.bookId, bookId), eq(characters.personaOf, from)))
    .run();
}
