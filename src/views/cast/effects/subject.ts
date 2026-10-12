// What an effects sheet is opened for: the book's thought effect, or one speaker — their own
// effect on all their lines, or their thought effect. The sheet can switch a speaker's slot itself.
// The book's can open straight in the editor on an effect (`effect`), to tune what it uses.
import type { EffectSlot } from "@/types";

export type EffectSubject =
  | { kind: "book"; effect?: string }
  | { kind: "speaker"; name: string; slot: EffectSlot };
