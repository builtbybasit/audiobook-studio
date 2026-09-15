// The voice lists each mock endpoint exposes, plus the two catalogues a "fetch voices from server"
// call discovers. Every consumer copies the entries it takes, so these arrays are never mutated.
import type { FishModel } from "@/lib/endpoints";
import type { Gender, Voice, VoiceRef } from "@/types";

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

/** What a `GET /model?self=true` would return for a Fish Audio account — the catalogue is the
 *  user's own voice library, so ids are reference_ids and there is no gender field, only tags.
 *  Two entries are unusable on purpose: one is still training, one is a voice-conversion model. */
export const FISH_MODELS: FishModel[] = [
  {
    _id: "fish0000000000000000000000000001",
    title: "Narrator · warm baritone",
    type: "tts",
    state: "trained",
    tags: ["male", "narration", "audiobook"],
    languages: ["en"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000002",
    title: "Young swordsman",
    type: "tts",
    state: "trained",
    tags: ["male", "youth"],
    languages: ["en", "zh"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000003",
    title: "Sect elder",
    type: "tts",
    state: "trained",
    tags: ["male", "elderly"],
    languages: ["zh"],
    visibility: "unlist",
  },
  {
    _id: "fish0000000000000000000000000004",
    title: "Lan’er",
    type: "tts",
    state: "trained",
    tags: ["female", "youth"],
    languages: ["zh"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000005",
    title: "Steward",
    type: "tts",
    state: "trained",
    // no gender tag at all — the picker shows this one as unknown
    tags: ["dry", "officious"],
    languages: ["en"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000006",
    title: "Drowned City narrator (training)",
    type: "tts",
    state: "created",
    tags: ["female"],
    languages: ["en"],
    visibility: "private",
  },
  {
    _id: "fish0000000000000000000000000007",
    title: "Voice conversion · test",
    type: "svc",
    state: "trained",
    tags: [],
    languages: ["en"],
    visibility: "private",
  },
];

// what a "Fetch voices from server" call would return for a fresh OpenAI-compatible endpoint (e.g. Kokoro-FastAPI, Orpheus, Piper bridges)
export const DISCOVERABLE_VOICES: Voice[] = [
  g("tara", "f", "Tara"),
  g("leah", "f", "Leah"),
  g("jess", "f", "Jess"),
  g("leo", "m", "Leo"),
  g("dan", "m", "Dan"),
  g("mia", "f", "Mia"),
  g("zac", "m", "Zac"),
  g("zoe", "f", "Zoe"),
];

export const voiceRef = (epId: string, voiceId: string): VoiceRef => `${epId}/${voiceId}`;
