// What an effects sheet is opened for: the book's thought effect, or one speaker — their own
// effect on all their lines, or their thought effect. The sheet can switch a speaker's slot itself.
export type EffectSlot = "all" | "thought";

export type EffectSubject = { kind: "book" } | { kind: "speaker"; name: string; slot: EffectSlot };
