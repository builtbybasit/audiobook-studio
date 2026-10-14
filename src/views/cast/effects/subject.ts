// What an effects sheet is opened for: the book's thought effect, or one speaker's slot.
// A line effect (`line`) opens only in the editor: the scripting model chooses it.
import type { EffectSlot } from "@/types";

export type EffectSubject =
  | { kind: "book"; effect?: string }
  | { kind: "speaker"; name: string; slot: EffectSlot }
  | { kind: "line"; effect: string };
