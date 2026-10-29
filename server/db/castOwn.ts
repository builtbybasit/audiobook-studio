// What a speaker has beyond `Character`, which a client writes back whole: the fields set by hand,
// and the profile. Only the cast operations and a script file's import write them.
import { and, asc, eq } from "drizzle-orm";

import type { CharacterProfile, HandSet, ScriptFileFact } from "@/types";
import type { Db, Tx } from "~/db/client";
import { characterFacts, characters } from "~/db/schema";

const EDITABLE: readonly HandSet[number][] = ["age", "voiceType"];

const speakerRow = (bookId: string, name: string) =>
  and(eq(characters.bookId, bookId), eq(characters.name, name));

/** Each speaker's hand-set fields. */
export function editedOf(db: Db | Tx, bookId: string): Map<string, HandSet> {
  const rows = db
    .select({ name: characters.name, edited: characters.edited })
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .all();
  return new Map(rows.map((r) => [r.name, r.edited]));
}

export const editedOne = (db: Db | Tx, bookId: string, name: string): HandSet =>
  db.select({ edited: characters.edited }).from(characters).where(speakerRow(bookId, name)).get()
    ?.edited ?? [];

/** `edited` is written in `EDITABLE`'s order, each field once. */
export function setOwn(
  db: Db | Tx,
  bookId: string,
  name: string,
  own: { edited?: readonly string[]; profile?: CharacterProfile },
): void {
  const edited = own.edited && EDITABLE.filter((f) => own.edited!.includes(f));
  db.update(characters)
    .set({ ...(edited ? { edited } : {}), ...(own.profile ? { profile: own.profile } : {}) })
    .where(speakerRow(bookId, name))
    .run();
}

/** A field that differs between the two is set by hand from now on. */
export const handChanged = <T extends Partial<Record<HandSet[number], unknown>>>(
  was: T,
  now: T,
): HandSet => EDITABLE.filter((f) => !Bun.deepEquals(was[f], now[f]));

/** The book's facts by chapter, in the order they were found, for a script file. */
export function factsByChapter(db: Db | Tx, bookId: string): Map<number, ScriptFileFact[]> {
  const out = new Map<number, ScriptFileFact[]>();
  const rows = db
    .select()
    .from(characterFacts)
    .where(eq(characterFacts.bookId, bookId))
    .orderBy(asc(characterFacts.id))
    .all();
  for (const { chapterId, speaker, kind, text } of rows)
    out.set(chapterId, [...(out.get(chapterId) ?? []), { speaker, kind, text }]);
  return out;
}
