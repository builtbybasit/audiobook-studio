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

/**
 * A book's clips whose sound is not what their lines' effects now make (`GET …/effects/stale`):
 * `lines` of them, of which `unavailable` cannot be redone — made with effects before the voice's
 * own file was kept beside them.
 */
export interface StaleSound {
  lines: number;
  unavailable: number;
}

/**
 * Everywhere an effect is chosen, across every book (`GET /api/effects/:id/uses`), so a delete or
 * an edit can say whom it reaches before it does. A book that follows the library is reached
 * through `library`, and is not listed in `books`.
 */
export interface EffectUses {
  /** the library's thought effect (settings `thoughts`) is it */
  library: boolean;
  /** books whose own thought effect it is */
  books: { id: string; title: string }[];
  /** characters choosing it as their effect, their thought effect, or both */
  speakers: {
    bookId: string;
    bookTitle: string;
    name: string;
    effect: boolean;
    thoughts: boolean;
  }[];
}
