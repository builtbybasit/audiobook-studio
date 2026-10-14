// Speaking a line as a character or one of their personas. A persona without its own voice reads
// in its character's, so a move changes only effects; one with a voice needs new speech.
import { personaOwner } from "@/lib/cast";
import type { Character, Segment } from "@/types";

/** The character first, then their personas in cast order; just `name` when there are none. */
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

/** Line `id` (and with `rest`, every later dialogue/thought line by `group`) not already `to`. */
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
