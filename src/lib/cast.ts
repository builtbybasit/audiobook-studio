// What a speaker is before anyone has said anything about them.
//
// Shared by the seeded world, the cast store and the server's scripting job, because all three
// bring speakers into a cast and a walk-on the model turned up has to look the same whichever of
// them found it — and who a speaker the model named its own way is (`castNameFor`). And which of a
// cast's names a line is written with (`namesIn`), what a clip is sent as hints when it is checked
// by ear. Nothing here reaches a store or the demo world.
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

/**
 * Where a speaker's voice comes from: their own, the book's Character voice, the Narrator's, or —
 * for a linked persona — the character they are a persona of (`of`), whichever voice that is.
 */
export type VoiceSource = "own" | "character" | "narrator" | "persona";

/** A book's cast by name: how the voice rule finds the Narrator and the character behind a persona. */
export type CastLookup = Pick<ReadonlyMap<string, Character>, "get">;

/**
 * The character a speaker is a linked persona of: the one their `personaOf` names, when that is
 * someone else in the cast. Undefined for anyone else, and for a persona whose `personaOf` names
 * nobody in the cast (or themselves), who keeps their own voice — a masked stranger stays a
 * stranger until someone links them.
 */
export function personaOwner<C>(
  c: Pick<Character, "name" | "personaOf"> | undefined,
  cast: Pick<ReadonlyMap<string, C>, "get">,
): C | undefined {
  return c?.personaOf && c.personaOf !== c.name ? cast.get(c.personaOf) : undefined;
}

/**
 * Whether a speaker is read in a voice someone picked: their own, or for a linked persona with
 * none, their character's (`speakerVoice`). What the "voiced" counts and "unassigned" filters
 * count.
 */
export const voiced = (
  c: Pick<Character, "name" | "voice" | "personaOf">,
  cast: Pick<ReadonlyMap<string, Pick<Character, "voice">>, "get">,
): boolean => !!(c.voice || personaOwner(c, cast)?.voice);

/**
 * Why `name` cannot be made a persona of `personaOf` in this cast, or null when they can. A persona
 * is of someone else in the cast who is not the Narrator and not a persona themselves, and a
 * speaker others are personas of cannot become one: one level only, so the voice rule never chains.
 * The server refuses a speaker written with a refused link; an import drops the link instead.
 */
export function personaRefusal(
  name: string,
  personaOf: string,
  cast: readonly Pick<Character, "name" | "personaOf">[],
): string | null {
  if (personaOf === name) return "A speaker cannot be a persona of themselves";
  if (name === NARRATOR) return "The Narrator cannot be a persona";
  if (personaOf === NARRATOR) return "A speaker cannot be a persona of the Narrator";
  const of = cast.find((c) => c.name === personaOf);
  if (!of) return `“${personaOf}” is not in this book’s cast`;
  if (of.personaOf)
    return `“${personaOf}” is a persona of “${of.personaOf}”, and a persona has none of its own`;
  const mine = cast.find((c) => c.personaOf === name && c.name !== name);
  if (mine) return `“${mine.name}” is a persona of “${name}”, so “${name}” cannot be one`;
  return null;
}

/**
 * The voice a speaker is read in — the one rule the narration job, its estimate and every page
 * that says "read in …" share. Anyone with a voice of their own is read in it, a linked persona
 * too: a masked stranger given a voice keeps it when the book says who they are, so linking them
 * changes nothing already heard. A linked persona with none (`personaOwner`) is read in whatever
 * voice their character is, one level only; anyone else, for anyone but the Narrator, in the book's
 * Character voice for their gender; else the Narrator's. A name not in the cast is a speaker of
 * unknown gender. So moving a line between a character and a voiceless persona of theirs never
 * changes its voice.
 */
export function speakerVoice(
  name: string,
  cast: CastLookup,
  cv: CharacterVoice | undefined,
): { ref: VoiceRef | null; from: VoiceSource; of?: string } {
  const c = cast.get(name);
  const owner = c?.voice ? undefined : personaOwner(c, cast);
  if (owner) return { ref: voiceOf(owner, cast, cv).ref, from: "persona", of: owner.name };
  return voiceOf(c ?? { name, gender: "?", voice: null }, cast, cv);
}

/** `speakerVoice` without the persona step. */
function voiceOf(
  c: Pick<Character, "name" | "gender" | "voice">,
  cast: CastLookup,
  cv: CharacterVoice | undefined,
): { ref: VoiceRef | null; from: VoiceSource } {
  if (c.voice) return { ref: c.voice, from: "own" };
  if (c.name !== NARRATOR) {
    const ref = characterVoiceFor(cv, c.gender);
    if (ref) return { ref, from: "character" };
  }
  return { ref: cast.get(NARRATOR)?.voice ?? null, from: "narrator" };
}

/**
 * Whether a line moved from speaker `from` to `to` is still read as its clip was: in the same voice
 * (`speakerVoice`) and with the same delivery style, the two things a clip is judged by that come
 * from its speaker (`compareReading`). Then the clip keeps its speech and only its effects may be
 * old, for Re-apply. So it is between a character and a linked persona with no style of their own,
 * and between any two speakers who share a voice and a style.
 */
export function sameReading(
  from: string,
  to: string,
  cast: CastLookup,
  cv: CharacterVoice | undefined,
): boolean {
  return (
    speakerVoice(from, cast, cv).ref === speakerVoice(to, cast, cv).ref &&
    (cast.get(from)?.style ?? "") === (cast.get(to)?.style ?? "")
  );
}

/**
 * The cast member a scripting model meant by `speaker`, by name: a name in the cast is itself;
 * otherwise one written as one of a member's other names ("Hero" for Young Soldier) or in another
 * case is that member's. A bracket note after the name ("Young Soldier (male)") is dropped first —
 * a guard: no model has been seen copying the cast list's notes in. Any other name, and one that
 * could be two members', is left as written, so the job adds it as a walk-on rather than guessing
 * whose line it is.
 */
export function castNameFor(
  speaker: string,
  cast: readonly Pick<PromptCastMember, "name" | "aliases">[],
): string {
  if (cast.some((c) => c.name === speaker)) return speaker;
  const key = speaker.replace(/\s*\([^()]*\)$/, "").toLowerCase();
  const named = cast.filter((c) => c.name.toLowerCase() === key);
  const meant = named.length
    ? named
    : cast.filter((c) => c.aliases?.some((a) => a.toLowerCase() === key));
  return meant.length === 1 ? meant[0].name : speaker;
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
