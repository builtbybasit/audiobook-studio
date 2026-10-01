// What a speaker is before anyone has said anything about them.
//
// Shared by the seeded world, the cast store and the server's scripting job, because all three
// bring speakers into a cast and a walk-on the model turned up has to look the same whichever of
// them found it. Nothing here reaches a store or the demo world.
import type { Character, CharacterVoice, Gender, VoiceRef } from "@/types";

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

/** The one speaker every book has: narration, thoughts, and every speaker with no other voice. */
export const narrator = (voice: Character["voice"] = null): Character => ({
  name: NARRATOR,
  aliases: [],
  gender: "n",
  description: "Narration, thoughts, and every speaker with no other voice.",
  voice,
  style: "",
  color: PALETTE[0],
  major: true,
});

/** The book's Character voice for a speaker of this gender, or null where it names none. */
export function characterVoiceFor(cv: CharacterVoice | undefined, gender: Gender): VoiceRef | null {
  if (!cv) return null;
  if (cv.by === "one") return cv.one;
  return gender === "m" ? cv.male : gender === "f" ? cv.female : cv.other;
}

/** Where a speaker's voice comes from: their own, the book's Character voice, or the Narrator's. */
export type VoiceSource = "own" | "character" | "narrator";

/**
 * The voice a speaker is read in — the one rule the narration job, its estimate and every page
 * that says "read in …" share. Their own voice; else, for anyone but the Narrator, the book's
 * Character voice for their gender; else the Narrator's. A name not in the cast is a speaker of
 * unknown gender.
 */
export function speakerVoice(
  name: string,
  c: Character | undefined,
  narratorVoice: VoiceRef | null,
  cv: CharacterVoice | undefined,
): { ref: VoiceRef | null; from: VoiceSource } {
  if (c?.voice) return { ref: c.voice, from: "own" };
  if (name !== NARRATOR) {
    const ref = characterVoiceFor(cv, c?.gender ?? "?");
    if (ref) return { ref, from: "character" };
  }
  return { ref: narratorVoice, from: "narrator" };
}
