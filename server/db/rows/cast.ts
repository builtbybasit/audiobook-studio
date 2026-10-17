// The cast and the pronunciation dictionary.
import type { Character, LexEntry } from "@/types";
import type { characters, lexiconEntries } from "~/db/schema";

type CharacterRow = typeof characters.$inferSelect;
type LexRow = typeof lexiconEntries.$inferSelect;

export function toCharacter(row: CharacterRow): Character {
  const c: Character = {
    name: row.name,
    aliases: row.aliases,
    gender: row.gender,
    description: row.description,
    voice: row.voice ?? null,
    style: row.style,
    color: row.color,
    major: row.major,
  };
  if (row.isNew) c.isNew = true;
  if (row.keep) c.keep = true;
  if (row.effect != null) c.effect = row.effect;
  if (row.thoughts != null) c.thoughts = row.thoughts;
  if (row.personaOf != null) c.personaOf = row.personaOf;
  if (row.speed != null) c.speed = row.speed;
  if (row.masked) c.masked = true;
  return c;
}

export function characterValues(
  bookId: string,
  c: Character,
  position: number,
): typeof characters.$inferInsert {
  return {
    bookId,
    name: c.name,
    aliases: c.aliases,
    gender: c.gender,
    description: c.description,
    voice: c.voice,
    style: c.style,
    color: c.color,
    major: c.major,
    isNew: c.isNew ?? null,
    keep: c.keep ?? null,
    effect: c.effect ?? null,
    thoughts: c.thoughts ?? null,
    personaOf: c.personaOf ?? null,
    masked: c.masked ?? null,
    speed: c.speed ?? null,
    position,
  };
}

export function toLexEntry(row: LexRow): LexEntry {
  const e: LexEntry = {
    id: row.id,
    term: row.term,
    say: row.say,
    enabled: row.enabled,
  };
  if (row.ipa != null) e.ipa = row.ipa;
  if (row.note != null) e.note = row.note;
  if (row.matchCase) e.matchCase = true;
  return e;
}

export function lexiconValues(
  bookId: string,
  e: LexEntry,
  position: number,
): typeof lexiconEntries.$inferInsert {
  return {
    bookId,
    id: e.id,
    term: e.term,
    say: e.say,
    ipa: e.ipa ?? null,
    note: e.note ?? null,
    matchCase: e.matchCase ?? null,
    enabled: e.enabled,
    position,
  };
}
