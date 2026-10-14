// Which effects a line is given, and the fingerprint of what was baked into its clip. Shared by the
// server (narration, Re-apply) and the page (the "old sound" count), so both read it the same way.
import type { Character, Effect, SegmentType, Step, ThoughtChoice } from "@/types";
import { personaOwner } from "@/lib/cast";

export interface EffectContext {
  /** in the library's order, which a line's own effects run in */
  effects: ReadonlyMap<string, Effect>;
  /** the library's thought effect (settings `thoughts`) */
  library: ThoughtChoice;
  /** the book's own; null = follow the library */
  book: ThoughtChoice | null;
  /** by speaker name */
  cast: ReadonlyMap<string, Pick<Character, "effect" | "thoughts" | "personaOf">>;
}

/** Speaker → book → library. */
export function thoughtEffectOf(speaker: string, ctx: EffectContext): Effect | null {
  const choice = ctx.cast.get(speaker)?.thoughts ?? ctx.book ?? ctx.library;
  return choice === "none" ? null : (ctx.effects.get(choice) ?? null);
}

/**
 * In order: a persona's character's effect, the speaker's, the line's own in library order, then
 * for thoughts the thought effect. Unknown ids are skipped.
 */
export function chainsFor(
  line: { type: SegmentType; speaker: string; effects?: readonly string[] },
  ctx: EffectContext,
): Effect[] {
  const me = ctx.cast.get(line.speaker);
  const owner = personaOwner(me && { name: line.speaker, ...me }, ctx.cast);
  const out: Effect[] = [];
  for (const id of [owner?.effect, me?.effect]) {
    const worn = id ? ctx.effects.get(id) : undefined;
    if (worn) out.push(worn);
  }
  if (line.effects?.length) {
    const on = new Set(line.effects);
    for (const e of ctx.effects.values()) if (on.has(e.id)) out.push(e);
  }
  if (line.type === "thought") {
    const thought = thoughtEffectOf(line.speaker, ctx);
    if (thought) out.push(thought);
  }
  return out;
}

/** Drops off steps, off layers and mixes with no layer left. */
export function runnable(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    if (!s.on) continue;
    if ("mix" in s) {
      const mix = s.mix
        .filter((l) => l.on)
        .map((l) => ({ name: l.name, steps: runnable(l.steps), on: true }));
      if (mix.length) out.push({ mix, on: true });
    } else out.push({ plugin: s.plugin, params: s.params, on: true });
  }
  return out;
}

/** Null when they do nothing. Names, ids and off steps don't count. */
export function soundOf(effects: Effect[]): string | null {
  const chains = effects.map((e) => runnable(e.chain)).filter((c) => c.length);
  if (!chains.length) return null;
  const text = JSON.stringify(chains, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  // FNV-1a, 32-bit: the same in Bun and the browser
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
