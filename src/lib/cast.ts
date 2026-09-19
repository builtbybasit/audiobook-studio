// What a speaker is before anyone has said anything about them.
//
// Shared by the seeded world, the cast store and the server's scripting job, because all three
// bring speakers into a cast and a walk-on the model turned up has to look the same whichever of
// them found it. Nothing here reaches a store or the demo world.
import type { Character } from "@/types";

/** The colours a cast is assigned from, in the order speakers arrive. */
export const PALETTE: string[] = [
  "#a78bfa",
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#fb923c",
  "#2dd4bf",
  "#f87171",
  "#c084fc",
  "#4ade80",
];

/** A walk-on speaker the model turned up that the cast has no entry for yet. */
export const newSpeaker = (name: string, castSize: number): Character => ({
  name,
  aliases: [],
  gender: "?",
  description: "",
  voice: null,
  style: "",
  color: PALETTE[castSize % PALETTE.length],
  major: false,
  isNew: true,
});

export const NARRATOR = "Narrator";

/** The one speaker every book has: narration, thoughts, and every speaker without a voice of their own. */
export const narrator = (voice: Character["voice"] = null): Character => ({
  name: NARRATOR,
  aliases: [],
  gender: "n",
  description: "Narration, thoughts, and every speaker without a voice of their own.",
  voice,
  style: "",
  color: PALETTE[0],
  major: true,
});
