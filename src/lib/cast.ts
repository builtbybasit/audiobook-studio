// What a speaker is before anyone has said anything about them.
//
// Shared by the seeded world, the cast store and the server's scripting job, because all three
// bring speakers into a cast and a walk-on the model turned up has to look the same whichever of
// them found it. Nothing here reaches a store or the demo world.
import type { Character, VoiceRef } from "@/types";

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

/** How a speaker names their voice: the endpoint it is on, and its id there. */
export const voiceRef = (epId: string, voiceId: string): VoiceRef => `${epId}/${voiceId}`;

/** The delivery notes a direction is picked from, and the seeded scripts are written with. */
export const DIRECTIONS: string[] = [
  "calm, measured",
  "urgent, breathless",
  "whispered, hesitant",
  "dry, amused",
  "cold and clipped",
  "warm, gentle",
  "rising anger",
  "weary, slow",
  "excited, quick",
  "sarcastic, flat",
  "gravely serious",
  "teasing, light",
  "trembling",
  "commanding",
  "muttered under breath",
];

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
