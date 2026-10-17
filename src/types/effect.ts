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
  /** chapters holding any of `lines`, in reading order */
  chapters: ExistingChapter[];
}

/** One chapter's share of the finished lines a voice or effect change left behind. */
export interface ExistingChapter {
  id: number;
  lines: number;
  /** effect: lines with no raw file, which only re-narrating changes */
  unavailable?: number;
  /** voice: worst-case dollars to re-narrate the chapter's lines; null when unpriced */
  cost?: number | null;
}

/**
 * `POST …/characters/old-voice`: the named speakers' finished lines made with a voice other than
 * the one their line gets now (own voice, persona fallback, Character voice and Narrator included).
 */
export interface OldVoice {
  lines: number;
  /** worst-case dollars to re-narrate them all; null when any is unpriced */
  cost: number | null;
  chapters: ExistingChapter[];
}

/** Which chapters a Re-apply, a Keep or a re-voice reaches; absent `chapters` = all of them. */
export interface ExistingScope {
  chapters?: number[];
  /** only this speaker's lines, and their personas' */
  speaker?: string;
  /** exactly these speakers' lines, personas not added: the ones a voice's speed reaches */
  speakers?: string[];
}

/**
 * `GET /api/effects/:id/uses`, so a delete or edit can say whom it reaches. A book that follows the
 * library is reached through `library`, not listed in `books`.
 */
export interface EffectUses {
  /** script lines that carry it as a line effect, in every book */
  lines: number;
  /** it is the library's thought effect */
  library: boolean;
  /** books whose own thought effect it is */
  books: { id: string; title: string }[];
  speakers: (SpeakerEffectUse & { bookTitle: string })[];
}
