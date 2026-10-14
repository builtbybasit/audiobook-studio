// Voice effects: named Pedalboard chains kept for the whole library.
// A speaker can wear one on all of their lines, and a `thought` line gets a thought
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
  /**
   * When a line is heard through it, in one sentence for the scripting model ("words sent mind to
   * mind"): an effect with one is offered to the model as a line effect (`Segment.effects`).
   * Absent = never offered; it can still be worn by a speaker or put on a line by hand.
   */
  useWhen?: string;
}

/**
 * The thought effect chosen at one level — a speaker, a book, the library: an effect's id, or
 * `"none"` for no thought effect. Absent (null) on a speaker or a book = follow the next level.
 */
export type ThoughtChoice = string;

/**
 * A speaker's two effect choices, named as their fields on `Character`: their effect on all their
 * lines, and their thought effect.
 */
export type EffectSlot = "effect" | "thoughts";

/** One speaker's choices of one effect: as their effect, their thought effect, or both. */
export interface SpeakerEffectUse {
  bookId: string;
  name: string;
  effect: boolean;
  thoughts: boolean;
}

/**
 * A book's clips whose sound is not what their lines' effects now make (`GET …/effects/stale`):
 * `lines` of them, of which `unavailable` cannot be redone — made with effects before the voice's
 * own file was kept beside them. `ready` says whether effects can run on this server at all (uv
 * and Pedalboard found): without it a Re-apply can only fail, so the page says why instead.
 */
export interface StaleSound {
  lines: number;
  unavailable: number;
  ready: boolean;
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
  speakers: (SpeakerEffectUse & { bookTitle: string })[];
}
