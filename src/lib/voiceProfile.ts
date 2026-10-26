// The words voice profiles and cast notes share, and how measured numbers read as those words:
// against thirds of the user's own library per gender, since game and studio voices all measure
// "rough" by clinical limits.
import type {
  Delivery,
  Gender,
  MeasuredVoice,
  Pitch,
  Texture,
  Voice,
  VoiceProfile,
  VoiceType,
} from "@/types";

export const PITCHES: readonly Pitch[] = ["low", "mid", "high"];
export const TEXTURES: readonly Texture[] = ["husky", "clear"];
export const DELIVERIES: readonly Delivery[] = [
  "calm",
  "warm",
  "cold",
  "gentle",
  "playful",
  "cheerful",
  "energetic",
  "shy",
  "sly",
  "haughty",
  "stern",
  "menacing",
  "weary",
  "theatrical",
  "seductive",
  "deadpan",
];

/** Less voiced speech than this and the measured words are shown as rough. */
export const ROUGH_BELOW_SEC = 20;
/** Fewer measured voices of a gender than this and typical values stand in for the library. */
const LIBRARY_MIN = 9;

/** The two cut points splitting each measure into thirds. */
export interface VoiceBands {
  f0: [number, number];
  hnr: [number, number];
  rangeSt: [number, number];
}

// thirds of 69 measured game and audiobook voices, 2026-10-26
const TYPICAL: Record<"f" | "m", VoiceBands> = {
  f: { f0: [209, 250], hnr: [12.5, 14.1], rangeSt: [10.9, 15.2] },
  m: { f0: [111, 122], hnr: [7.2, 8.9], rangeSt: [10.9, 15.9] },
};

const thirds = (xs: number[]): [number, number] => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return [at(1 / 3), at(2 / 3)];
};

/** Bands for male and female voices; other genders have no pitch band. */
export function voiceBands(voices: readonly Voice[]): Partial<Record<Gender, VoiceBands>> {
  const out: Partial<Record<Gender, VoiceBands>> = {};
  for (const g of ["f", "m"] as const) {
    const ms = voices
      .filter((v) => v.gender === g && v.profile?.measured)
      .map((v) => v.profile!.measured!);
    out[g] =
      ms.length < LIBRARY_MIN
        ? TYPICAL[g]
        : {
            f0: thirds(ms.map((m) => m.f0)),
            hnr: thirds(ms.map((m) => m.hnr)),
            rangeSt: thirds(ms.map((m) => m.rangeSt)),
          };
  }
  return out;
}

const third = (x: number, [lo, hi]: [number, number]): 0 | 1 | 2 => (x < lo ? 0 : x < hi ? 1 : 2);

export interface MeasuredWords {
  pitch?: Pitch;
  texture?: Texture;
  intonation: "steady" | "even" | "lively";
  /** too little speech to trust */
  rough: boolean;
}

/** How measured numbers read; texture is left blank in the middle third. */
export function measuredWords(
  m: MeasuredVoice,
  gender: Gender,
  bands: Partial<Record<Gender, VoiceBands>>,
): MeasuredWords {
  const b = bands[gender] ?? TYPICAL.f;
  const t = third(m.hnr, b.hnr);
  return {
    ...(bands[gender] ? { pitch: PITCHES[third(m.f0, b.f0)] } : {}),
    ...(t !== 1 ? { texture: t === 0 ? "husky" : "clear" } : {}),
    intonation: (["steady", "even", "lively"] as const)[third(m.rangeSt, b.rangeSt)],
    rough: m.voicedSec < ROUGH_BELOW_SEC,
  };
}

/** A voice in the words a cast note uses, for matching against `Character.voiceType`. */
export function voiceTypeOf(voice: Voice, bands: Partial<Record<Gender, VoiceBands>>): VoiceType {
  const p = voice.profile;
  const w = p?.measured && measuredWords(p.measured, voice.gender, bands);
  return {
    ...(w?.pitch ? { pitch: w.pitch } : {}),
    ...(w?.texture ? { texture: w.texture } : {}),
    ...(p?.delivery?.length ? { delivery: p.delivery } : {}),
  };
}

const blank = (x: unknown): boolean =>
  x == null || x === "" || (Array.isArray(x) && x.length === 0);

/** A fresh fill over what the user has: measurements and the source are replaced, the rest only fills blanks. */
export function mergeProfile(current: VoiceProfile | undefined, fresh: VoiceProfile): VoiceProfile {
  const out: VoiceProfile = { ...current };
  for (const key of Object.keys(fresh) as (keyof VoiceProfile)[]) {
    const replace = key === "measured" || key === "source";
    if (replace || blank(out[key])) (out as Record<string, unknown>)[key] = fresh[key];
  }
  return out;
}
