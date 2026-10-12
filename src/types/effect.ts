// Voice effects: named Pedalboard chains kept for the whole library (docs/audio.md, "Voice
// effects"). A speaker can wear one on all of their lines, and a `thought` line gets a thought
// effect after it, chosen speaker → book → library (`src/lib/effects.ts`).

/** One Pedalboard plugin and its keyword arguments; an off step is kept but not run. */
export interface PluginStep {
  plugin: string;
  params: Record<string, number>;
  on: boolean;
}

/** One parallel path inside a `Mix`. */
export interface Layer {
  name: string;
  steps: Step[];
  on: boolean;
}

/** Pedalboard's `Mix`: the layers run side by side on the same input and are summed. */
export interface MixStep {
  mix: Layer[];
  on: boolean;
}

export type Step = PluginStep | MixStep;

export interface Effect {
  id: string;
  name: string;
  chain: Step[];
}

/**
 * The thought effect chosen at one level — a speaker, a book, the library: an effect's id, or
 * `"none"` for no thought effect. Absent (null) on a speaker or a book = follow the next level.
 */
export type ThoughtChoice = string;
