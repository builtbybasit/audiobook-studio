// Matching speakers to voices by their tags (gender, age, voice type), never their descriptions, so
// a reason can be shown without spoiling anything. Voice types are worked out once per call, not
// per pair: a book is 350 speakers against a library of 100 voices.
import type { Age, CastStat, Character, Gender, Voice, VoiceRef, VoiceType } from "@/types";
import { AGES, NARRATOR, personaOwner } from "@/lib/cast";
import { type VoiceBands, voiceTypeOf } from "@/lib/voiceProfile";

export type Bands = Partial<Record<Gender, VoiceBands>>;
/** A voice where a speaker can be given it. */
export interface LibraryVoice {
  ref: VoiceRef;
  voice: Voice;
}
export interface VoiceScore {
  score: number;
  /** short tag words, e.g. "same age", "low", "cold" */
  reasons: string[];
}
export interface FitRow extends VoiceScore {
  name: string;
  voice: VoiceRef;
}
export interface VoiceGap {
  gender: Gender;
  age: Age;
  /** e.g. "elderly men" */
  label: string;
  speakers: number;
  voices: number;
}

/** Fewer voices with a profile than this and matching by fit is no better than by gender. */
export const FIT_MIN = 3;
export const profiled = (v: Voice): boolean =>
  !!(v.profile?.age || v.profile?.delivery?.length || v.profile?.measured);

// "avoid" phrases are free text; these catch the ones about a speaker's age group
const AVOID_AGE: Record<Age, RegExp> = {
  child: /\b(child|children|kids?)\b/i,
  teen: /\bteen/i,
  "young adult": /\byoung\b/i,
  "middle-aged": /\bmiddle-aged\b/i,
  elderly: /\b(elderly|old)\b/i,
};

const known = (g: Gender) => g !== "?";

function scoreTyped(c: Character, v: Voice, vt: VoiceType): VoiceScore | null {
  if (known(c.gender) && known(v.gender) && c.gender !== v.gender) return null;
  let score = 0;
  const reasons: string[] = [];
  const p = v.profile;
  if (c.age && p?.age) {
    const d = Math.abs(AGES.indexOf(c.age) - AGES.indexOf(p.age));
    if (d === 0) {
      score += 3;
      reasons.push("same age");
    } else if (d === 1) {
      score += 1;
      reasons.push("near age");
    }
  }
  const want = c.voiceType;
  if (want?.pitch && want.pitch === vt.pitch) {
    score += 2;
    reasons.push(vt.pitch);
  }
  if (want?.texture && want.texture === vt.texture) {
    score += 1;
    reasons.push(vt.texture);
  }
  for (const d of want?.delivery ?? [])
    if (vt.delivery?.includes(d)) {
      score += 1;
      reasons.push(d);
    }
  if (c.age && p?.avoid?.some((a) => AVOID_AGE[c.age!].test(a))) score -= 3;
  return { score, reasons };
}

/** How well a voice fits a speaker; null when their genders are both known and differ. */
export function scoreVoice(c: Character, v: Voice, bands: Bands): VoiceScore | null {
  return scoreTyped(c, v, voiceTypeOf(v, bands));
}

const typed = (voices: readonly LibraryVoice[], bands: Bands) =>
  voices.map((lv) => ({ ...lv, vt: voiceTypeOf(lv.voice, bands) }));

/** The three best fits for one speaker; a voice no one else in the book uses edges ahead. */
export function suggestVoices(
  c: Character,
  voices: readonly LibraryVoice[],
  bands: Bands,
  usedBy: Partial<Record<VoiceRef, string[]>>,
): (FitRow & { used: boolean })[] {
  const out: (FitRow & { used: boolean })[] = [];
  for (const { ref, voice, vt } of typed(voices, bands)) {
    const s = scoreTyped(c, voice, vt);
    if (!s || s.score <= 0) continue;
    const used = !!usedBy[ref]?.some((n) => n !== c.name);
    out.push({
      name: c.name,
      voice: ref,
      score: s.score + (used ? 0 : 0.5),
      reasons: s.reasons,
      used,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

/**
 * A voice for every unvoiced speaker (not the Narrator, not a linked persona), main cast first then
 * by lines. Main speakers never share a voice while one is free; minor ones take their best fit,
 * the least used of equals, and a main speaker's voice only when nothing else fits as well.
 */
export function fitPlan(
  cast: readonly Character[],
  voices: readonly LibraryVoice[],
  bands: Bands,
  counts: Partial<Record<string, Pick<CastStat, "lines">>>,
): FitRow[] {
  if (!voices.length) return [];
  const pool = typed(voices, bands);
  const byName = new Map(cast.map((c) => [c.name, c]));
  const uses = new Map<VoiceRef, number>();
  const mainTaken = new Set<VoiceRef>();
  for (const c of cast)
    if (c.voice) {
      uses.set(c.voice, (uses.get(c.voice) ?? 0) + 1);
      if (c.major) mainTaken.add(c.voice);
    }
  const lines = (c: Character) => counts[c.name]?.lines ?? 0;
  const todo = cast
    .filter((c) => !c.voice && c.name !== NARRATOR && !personaOwner(c, byName))
    .sort((a, b) => Number(b.major) - Number(a.major) || lines(b) - lines(a));
  const hasGender = new Set(pool.map((v) => v.voice.gender));
  const out: FitRow[] = [];
  const bestFor = (c: Character, who: Character, skipTaken: boolean) => {
    let best: (FitRow & { tie: number }) | undefined;
    for (const { ref, voice, vt } of pool) {
      const taken = mainTaken.has(ref);
      if (skipTaken && taken) continue;
      const s = scoreTyped(who, voice, vt);
      if (!s) continue;
      const tie = (taken ? 1e6 : 0) + (uses.get(ref) ?? 0);
      if (!best || s.score > best.score || (s.score === best.score && tie < best.tie))
        best = { name: c.name, voice: ref, ...s, tie };
    }
    return best;
  };
  for (const c of todo) {
    // no voice of their gender: any voice will do, as matching by gender does
    const who = hasGender.has(c.gender) ? c : { ...c, gender: "?" as Gender };
    const best = (c.major && bestFor(c, who, true)) || bestFor(c, who, false);
    if (!best) continue;
    const { tie: _tie, ...row } = best;
    out.push(row);
    uses.set(row.voice, (uses.get(row.voice) ?? 0) + 1);
    if (c.major) mainTaken.add(row.voice);
  }
  return out;
}

const AGE_WORDS: Record<Age, Record<"m" | "f" | "n", string>> = {
  child: { m: "boys", f: "girls", n: "children" },
  teen: { m: "teen boys", f: "teen girls", n: "teens" },
  "young adult": { m: "young men", f: "young women", n: "young adults" },
  "middle-aged": { m: "middle-aged men", f: "middle-aged women", n: "middle-aged people" },
  elderly: { m: "elderly men", f: "elderly women", n: "elderly people" },
};

/**
 * Kinds of speaker (gender and age) the library has no voice for, or ten times fewer voices than
 * speakers; most speakers first. Speakers of unknown gender or age are left out.
 */
export function voiceGaps(
  cast: readonly Character[],
  voices: readonly LibraryVoice[],
  counts: Partial<Record<string, Pick<CastStat, "lines">>>,
): VoiceGap[] {
  const key = (g: Gender, a: Age) => `${g}|${a}`;
  const have = new Map<string, number>();
  for (const { voice } of voices)
    if (voice.profile?.age && known(voice.gender)) {
      const k = key(voice.gender, voice.profile.age);
      have.set(k, (have.get(k) ?? 0) + 1);
    }
  const need = new Map<string, { gender: Gender; age: Age; speakers: number; lines: number }>();
  for (const c of cast) {
    if (c.name === NARRATOR || !c.age || !known(c.gender)) continue;
    const k = key(c.gender, c.age);
    const n = need.get(k) ?? { gender: c.gender, age: c.age, speakers: 0, lines: 0 };
    n.speakers++;
    n.lines += counts[c.name]?.lines ?? 0;
    need.set(k, n);
  }
  return [...need]
    .map(([k, n]) => ({ ...n, voices: have.get(k) ?? 0 }))
    .filter((g) => g.voices === 0 || g.speakers >= g.voices * 10)
    .sort((a, b) => b.speakers - a.speakers || b.lines - a.lines)
    .map(({ lines: _lines, ...g }) => ({
      ...g,
      label: AGE_WORDS[g.age][g.gender as "m" | "f" | "n"],
    }));
}
