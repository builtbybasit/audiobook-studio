// What a speaker is before anyone has said anything about them.
//
// Shared by the seeded world, the cast store and the server's scripting job, because all three
// bring speakers into a cast and a walk-on the model turned up has to look the same whichever of
// them found it. And which of a cast's names a line is written with (`namesIn`), what a clip is
// sent as hints when it is checked by ear. Nothing here reaches a store or the demo world.
import type { Character, CharacterVoice, Gender, VoiceRef } from "@/types";
import { writtenWordsOf } from "@/lib/gaps";
import type { PromptCastMember } from "@/lib/prompt";

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

/** Which of the Character voice's slots a speaker of this gender is read in. */
export const characterSlot = (
  cv: CharacterVoice,
  gender: Gender,
): "one" | "male" | "female" | "other" =>
  cv.by === "one" ? "one" : gender === "m" ? "male" : gender === "f" ? "female" : "other";

/** The book's Character voice for a speaker of this gender, or null where it names none. */
export function characterVoiceFor(cv: CharacterVoice | undefined, gender: Gender): VoiceRef | null {
  return cv ? cv[characterSlot(cv, gender)] : null;
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

// ---------- names in a line ----------

/** Words a speaker's name can start with that name nobody: "The man" must not hint every "The". */
const NOT_NAMES = new Set(["the", "a", "an", "mr", "mrs", "ms", "miss", "dr", "sir", "madam"]);

/**
 * The words a cast is named by — those its names and aliases spell with a capital, the narrator's
 * aside — keyed by the word as compared, to the word as the cast spells it. An initial and a title
 * are left out.
 */
export function nameWords(
  cast: readonly Pick<PromptCastMember, "name" | "aliases">[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cast) {
    if (c.name === NARRATOR) continue;
    for (const w of [c.name, ...(c.aliases ?? [])].flatMap(writtenWordsOf)) {
      const key = w.toLowerCase();
      if (/^\p{Lu}/u.test(w) && key.length > 1 && !NOT_NAMES.has(key) && !out.has(key))
        out.set(key, w);
    }
  }
  return out;
}

/**
 * The cast's name words a line is written with, as the cast spells them, in the line's order and
 * once each. A word counts when it is written with a capital — "NOEL!" and a stuttered "N-Noel" do,
 * "I will go" never names Will — and a possessive ("Noel's", "James'") is read as its name.
 */
export function namesIn(text: string, words: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const w of writtenWordsOf(text)) {
    if (!/^\p{Lu}/u.test(w)) continue;
    const name = words.get(w.toLowerCase().replace(/'s$/, "")) ?? words.get(w.toLowerCase());
    if (name) out.add(name);
  }
  return [...out];
}
