// Which effects a line is given, and the fingerprint of what was baked into its clip. Shared by the
// server (narration, Re-apply) and the page (the "old sound" count), so both read it the same way.
import type { Effect, SegmentType, Step, ThoughtChoice } from "@/types";

/** What a line's effects are read from. */
export interface EffectContext {
  effects: ReadonlyMap<string, Effect>;
  /** the library's thought effect (settings `thoughts`) */
  library: ThoughtChoice;
  /** the book's own; null = follow the library */
  book: ThoughtChoice | null;
  /** by speaker name; a speaker not in it follows the book and wears nothing */
  cast: ReadonlyMap<string, { effect?: string; thoughts?: ThoughtChoice }>;
}

/** The thought effect a speaker's thought lines get: speaker → book → library. */
export function thoughtEffectOf(speaker: string, ctx: EffectContext): Effect | null {
  const choice = ctx.cast.get(speaker)?.thoughts ?? ctx.book ?? ctx.library;
  return choice === "none" ? null : (ctx.effects.get(choice) ?? null);
}

/** The effects a line is run through, in order: the speaker's own, then (thoughts) the thought effect. */
export function chainsFor(
  line: { type: SegmentType; speaker: string },
  ctx: EffectContext,
): Effect[] {
  const own = ctx.cast.get(line.speaker)?.effect;
  const out: Effect[] = [];
  const worn = own ? ctx.effects.get(own) : undefined;
  if (worn) out.push(worn);
  if (line.type === "thought") {
    const thought = thoughtEffectOf(line.speaker, ctx);
    if (thought) out.push(thought);
  }
  return out;
}

/** The steps that run: off steps, off layers and mixes with no layer left are dropped. */
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

/**
 * The fingerprint of what these effects do to a clip, or null when they do nothing — so a clip
 * whose `sound` differs from its line's has the old sound. Names, ids and off steps don't count.
 */
export function soundOf(effects: Effect[]): string | null {
  const chains = effects.map((e) => runnable(e.chain)).filter((c) => c.length);
  if (!chains.length) return null;
  const text = JSON.stringify(chains, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  // FNV-1a, 32-bit: enough to tell chains apart, and the same in Bun and the browser
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
