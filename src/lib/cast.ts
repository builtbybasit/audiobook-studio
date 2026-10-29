// Cast rules shared by the seeded world, the cast store and the server's scripting job: new
// speakers, the voice rule (`speakerVoice`), personas, and matching the model's names to the cast.
import type {
  Age,
  Character,
  CharacterVoice,
  FactKind,
  Gender,
  GenderSlot,
  Voice,
  VoiceRef,
} from "@/types";
import { writtenWordsOf } from "@/lib/gaps";
import type { PromptCastMember } from "@/lib/prompt";

export const FACT_KINDS: readonly FactKind[] = [
  "role",
  "background",
  "relationship",
  "personality",
  "voice",
];

/** Who they are: the user's description, else the profile's first part. For the scripting prompt. */
export const whoOf = (c: Pick<Character, "description" | "profile">): string =>
  c.description.trim() || (c.profile?.who ?? "");

/** All we know of them: the user's description, else the whole profile. For voice picks. */
export const describe = (c: Pick<Character, "description" | "profile">): string =>
  c.description.trim() ||
  [c.profile?.who, c.profile?.personality, c.profile?.voice].filter(Boolean).join(" ");

/** Assigned in the order speakers arrive. */
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

export const voiceRef = (epId: string, voiceId: string): VoiceRef => `${epId}/${voiceId}`;

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

/** A line count as a rough band, so a speaker's size gives little of the plot away. */
export const lineBand = (lines: number): string =>
  lines === 0 ? "none" : lines < 10 ? "a few" : lines < 100 ? "some" : "many";

/** "12 lines" when the book shows exact counts, else "some lines"; "no lines" either way. */
export const linesText = (lines: number, exact: boolean): string =>
  !lines
    ? "no lines"
    : exact
      ? `${lines} line${lines === 1 ? "" : "s"}`
      : `${lineBand(lines)} lines`;

export const AGES: readonly Age[] = ["child", "teen", "young adult", "middle-aged", "elderly"];

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

export const genderSlot = (gender: Gender): GenderSlot =>
  gender === "m" ? "male" : gender === "f" ? "female" : "other";

/** Where a speaker's Character voice comes from: "one", their gender's, or that gender's for their age. */
export type CharacterSlot = { slot: "one" | GenderSlot; age?: Age };

export function characterSlot(cv: CharacterVoice, gender: Gender, age?: Age): CharacterSlot {
  if (cv.by === "one") return { slot: "one" };
  const slot = genderSlot(gender);
  return age && cv.ages?.some((a) => a.slot === slot && a.age === age) ? { slot, age } : { slot };
}

export const slotVoice = (cv: CharacterVoice, { slot, age }: CharacterSlot): VoiceRef | null =>
  age ? (cv.ages?.find((a) => a.slot === slot && a.age === age)?.voice ?? null) : cv[slot];

/** "Character voice", "Character voice (female)", "Character voice (female, child)". */
export const slotLabel = ({ slot, age }: CharacterSlot): string =>
  slot === "one" ? "Character voice" : `Character voice (${age ? `${slot}, ${age}` : slot})`;

export function characterVoiceFor(
  cv: CharacterVoice | undefined,
  gender: Gender,
  age?: Age,
): VoiceRef | null {
  return cv ? slotVoice(cv, characterSlot(cv, gender, age)) : null;
}

export type VoiceSource = "own" | "character" | "narrator" | "persona";

export type CastLookup = Pick<ReadonlyMap<string, Character>, "get">;

/** Undefined unless `personaOf` names someone else in the cast. */
export function personaOwner<C>(
  c: Pick<Character, "name" | "personaOf"> | undefined,
  cast: Pick<ReadonlyMap<string, C>, "get">,
): C | undefined {
  return c?.personaOf && c.personaOf !== c.name ? cast.get(c.personaOf) : undefined;
}

/** Read in a picked voice: their own, or a voiceless linked persona's character's. */
export const voiced = (
  c: Pick<Character, "name" | "voice" | "personaOf">,
  cast: Pick<ReadonlyMap<string, Pick<Character, "voice">>, "get">,
): boolean => !!(c.voice || personaOwner(c, cast)?.voice);

/** Null when allowed. Personas are one level only, so the voice rule never chains. */
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
 * The one voice rule: own voice (a linked persona too, so linking changes nothing heard); else a
 * linked persona's character's; else the book's Character voice for their gender and age (not for
 * the Narrator); else the Narrator's. A name not in the cast has unknown gender and age.
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
  c: Pick<Character, "name" | "gender" | "age" | "voice">,
  cast: CastLookup,
  cv: CharacterVoice | undefined,
): { ref: VoiceRef | null; from: VoiceSource } {
  if (c.voice) return { ref: c.voice, from: "own" };
  if (c.name !== NARRATOR) {
    const ref = characterVoiceFor(cv, c.gender, c.age);
    if (ref) return { ref, from: "character" };
  }
  return { ref: cast.get(NARRATOR)?.voice ?? null, from: "narrator" };
}

/**
 * A speaker's pace: their own, else the voice `speakerVoice` gives them (a persona's character's
 * too), else 1. `voiceOf` finds a `<endpointId>/<voiceId>` on its endpoint.
 */
export function speakerSpeed(
  name: string,
  cast: CastLookup,
  cv: CharacterVoice | undefined,
  voiceOf: (ref: VoiceRef) => Pick<Voice, "speed"> | undefined,
): number {
  const own = cast.get(name)?.speed;
  if (own != null) return own;
  const ref = speakerVoice(name, cast, cv).ref;
  return (ref && voiceOf(ref)?.speed) || 1;
}

/** The cast whose pace is `ref`'s own speed: speaking in it (`speakerVoice`), setting none. */
export function speedFollowers(
  ref: VoiceRef,
  cast: readonly Character[],
  cv: CharacterVoice | undefined,
): string[] {
  const byName = new Map(cast.map((c) => [c.name, c]));
  return cast
    .filter((c) => c.speed == null && speakerVoice(c.name, byName, cv).ref === ref)
    .map((c) => c.name);
}

/**
 * Whether a line moved from `from` to `to` keeps its clip's speech: same voice, style and own speed
 * (unset is the shared voice's). Only its effects may then be old, for Re-apply. `after` is the cast
 * `to` is read in when the move changed the cast too (a rename, merge or removal).
 */
export function sameReading(
  from: string,
  to: string,
  cast: CastLookup,
  cv: CharacterVoice | undefined,
  after: CastLookup = cast,
): boolean {
  return (
    speakerVoice(from, cast, cv).ref === speakerVoice(to, after, cv).ref &&
    (cast.get(from)?.style ?? "") === (after.get(to)?.style ?? "") &&
    (cast.get(from)?.speed ?? null) === (after.get(to)?.speed ?? null)
  );
}

/**
 * The cast member the model meant by `speaker`: exact name, else a case-insensitive name or alias,
 * ignoring a trailing "(note)". Unknown or ambiguous names stay as written, to become walk-ons.
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

/**
 * `{{cast}}` for a chapter, in cast order: who the text names, who spoke recently (`recent`), and
 * every disguise with its wearer (a reveal can come much later).
 */
export function chapterCast<
  T extends Pick<PromptCastMember, "name" | "aliases" | "personaOf" | "masked">,
>(cast: readonly T[], text: string, recent: ReadonlySet<string>): T[] {
  const lower = text.toLowerCase();
  const word = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  const named = (name: string): boolean => {
    const key = name.trim().toLowerCase();
    for (let i = key ? lower.indexOf(key) : -1; i >= 0; i = lower.indexOf(key, i + 1))
      if (!word(lower[i - 1]) && !word(lower[i + key.length])) return true;
    return false;
  };
  const kept = new Set(
    cast
      .filter(
        (c) =>
          c.name === NARRATOR ||
          c.personaOf ||
          c.masked ||
          recent.has(c.name) ||
          [c.name, ...(c.aliases ?? [])].some(named),
      )
      .map((c) => c.name),
  );
  for (const c of cast) if (c.personaOf) kept.add(c.personaOf);
  return cast.filter((c) => kept.has(c.name));
}

// ---------- names in a line ----------

/** Words a speaker's name can start with that name nobody: "The man" must not hint every "The". */
const NOT_NAMES = new Set(["the", "a", "an", "mr", "mrs", "ms", "miss", "dr", "sir", "madam"]);

/** Capitalised words of the cast's names and aliases (no initials or titles): lowercase → spelled. */
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
 * Cast name words in a line, once each, in order. Only capitalised words count ("I will go" never
 * names Will); a possessive reads as its name.
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
