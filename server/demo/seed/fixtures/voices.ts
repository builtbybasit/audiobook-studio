// The voice lists each of the demo's endpoints exposes. Every consumer copies the entries it takes,
// so these arrays are never mutated.
import type { Gender, Voice } from "@/types";

// Voices belong to an endpoint (each TTS server exposes its own list). A character stores a voice
// *ref* — `<endpointId>/<voiceId>` — so narration knows which endpoint must render that speaker.
const g = (id: string, gender: Gender, label?: string): Voice => ({
  id,
  gender,
  label: label ?? id,
});

export const OPENAI_VOICES: Voice[] = [
  g("alloy", "n"),
  g("ash", "m"),
  g("ballad", "m"),
  g("coral", "f"),
  g("echo", "m"),
  g("fable", "n"),
  g("onyx", "m"),
  g("nova", "f"),
  g("sage", "f"),
  g("shimmer", "f"),
  g("verse", "m"),
];
export const KOKORO_VOICES: Voice[] = [
  g("af_heart", "f", "Heart"),
  g("af_bella", "f", "Bella"),
  g("af_nicole", "f", "Nicole"),
  g("am_adam", "m", "Adam"),
  g("am_michael", "m", "Michael"),
  g("bf_emma", "f", "Emma"),
  g("bm_george", "m", "George"),
  g("bm_lewis", "m", "Lewis"),
];
export const AZURE_VOICES: Voice[] = [
  g("alloy", "n"),
  g("echo", "m"),
  g("fable", "n"),
  g("onyx", "m"),
  g("nova", "f"),
  g("shimmer", "f"),
];

/** Fish Audio voices as this endpoint already holds them — a voice *is* a `reference_id`, so the
 *  ids are the 32-character ids of the models in the account's voice library. */
export const FISH_VOICES: Voice[] = [
  g("fish0000000000000000000000000001", "m", "Narrator · warm baritone"),
  g("fish0000000000000000000000000002", "m", "Young swordsman"),
  g("fish0000000000000000000000000003", "m", "Sect elder"),
  g("fish0000000000000000000000000004", "f", "Lan’er"),
  g("fish0000000000000000000000000005", "?", "Steward"),
];

/** Gemini's TTS voices are named rather than cloned. */
export const GEMINI_VOICES: Voice[] = [
  g("Zephyr", "f", "Zephyr"),
  g("Puck", "m", "Puck"),
  g("Charon", "m", "Charon"),
  g("Kore", "f", "Kore"),
  g("Fenrir", "m", "Fenrir"),
  g("Aoede", "f", "Aoede"),
];

export { voiceRef } from "@/lib/cast";
