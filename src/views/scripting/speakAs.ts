// Speaking a line as a character or as one of their personas.
//
// A linked persona (`personaOwner`) is read in its character's voice, so a character and their
// personas are one identity with one voice between them: moving a line inside it changes only the
// effects it is heard through, never its speech.
import { personaOwner } from "@/lib/cast";
import type { Character, Segment } from "@/types";

/**
 * Who a line spoken by `name` may be spoken as: their character first, then the character's
 * personas in cast order. Just `name` for a speaker who has no personas and is none.
 */
export function identityGroup(
  name: string,
  cast: readonly Pick<Character, "name" | "personaOf">[],
): string[] {
  const byName = new Map(cast.map((c) => [c.name, c]));
  const c = byName.get(name);
  const owner = personaOwner(c, byName) ?? c;
  if (!owner) return [name];
  const personas = cast.filter(
    (p) => p.name !== owner.name && personaOwner(p, byName)?.name === owner.name,
  );
  return [owner.name, ...personas.map((p) => p.name)];
}

/**
 * The lines a switch to `to` moves, each with the speaker it had: line `id`, and with `rest` every
 * dialogue or thought line after it in the chapter that anyone in `group` speaks. A line already
 * spoken as `to` is not a move.
 */
export function speakAsMoves(
  segments: readonly Pick<Segment, "id" | "type" | "speaker">[],
  id: number,
  to: string,
  group: readonly string[],
  rest: boolean,
): { id: number; from: string }[] {
  const at = segments.findIndex((s) => s.id === id);
  if (at < 0) return [];
  const later = rest
    ? segments
        .slice(at + 1)
        .filter((s) => (s.type === "dialogue" || s.type === "thought") && group.includes(s.speaker))
    : [];
  return [segments[at], ...later]
    .filter((s) => s.speaker !== to)
    .map((s) => ({ id: s.id, from: s.speaker }));
}
