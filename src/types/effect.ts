// Voice effects: named Pedalboard chains kept for the whole library. A speaker can wear one on all
// their lines; `thought` lines get one chosen speaker → book → library (`src/lib/effects.ts`).

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
   * One sentence for the scripting model ("words sent mind to mind"); with it, the effect is
   * offered as a line effect (`Segment.effects`). Absent = only worn by a speaker or set by hand.
   */
  useWhen?: string;
}

/** An effect id, or `"none"`. Absent (null) on a speaker or book = follow the next level. */
export type ThoughtChoice = string;

/** The two effect fields on `Character`. */
export type EffectSlot = "effect" | "thoughts";

export interface SpeakerEffectUse {
  bookId: string;
  name: string;
  effect: boolean;
  thoughts: boolean;
}

/**
 * `GET …/effects/stale`: clips whose sound no longer matches their effects. `unavailable` ones have
 * no raw file to redo from. `ready` is false without uv/Pedalboard, so Re-apply would fail.
 */
export interface StaleSound {
  lines: number;
  unavailable: number;
  ready: boolean;
}

/**
 * `GET /api/effects/:id/uses`, so a delete or edit can say whom it reaches. A book that follows the
 * library is reached through `library`, not listed in `books`.
 */
export interface EffectUses {
  /** it is the library's thought effect */
  library: boolean;
  /** books whose own thought effect it is */
  books: { id: string; title: string }[];
  speakers: (SpeakerEffectUse & { bookTitle: string })[];
}
