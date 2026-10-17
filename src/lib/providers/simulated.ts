// An endpoint of any kind answered by this server: `simulated://…` names no host. Priced at its
// rate card like any other, but every row is marked simulated; it honours the endpoint's `latency`
// and `failRate` so a run behaves like a real one.
import type { Voice } from "@/types";
import type { SpeechProviderShape } from "@/lib/providers/types";

/** Any `simulated:` URL is one. */
export const SIMULATED_BASE_URL = "simulated://local";

export const isSimulated = (baseUrl: string): boolean => /^simulated:/i.test(baseUrl.trim());

export const SIMULATED_SPEECH_MODEL = "simulated-tts";
export const SIMULATED_SCRIPTING_MODEL = "simulated-script";
export const SIMULATED_TRANSCRIPTION_MODEL = "simulated-stt";

/** Each its own pitch. */
export const SIMULATED_VOICES: readonly Voice[] = [
  { id: "ash", label: "Ash", gender: "m" },
  { id: "birch", label: "Birch", gender: "f" },
  { id: "cedar", label: "Cedar", gender: "m" },
  { id: "elm", label: "Elm", gender: "f" },
  { id: "hazel", label: "Hazel", gender: "f" },
  { id: "rowan", label: "Rowan", gender: "n" },
];

export const simulated: SpeechProviderShape = {
  id: "simulated",
  label: "Simulated (free)",
  matches: isSimulated,
  requestPath: () => "",
  // the fake writes WAV and answers at whichever rate it is asked for
  formats: [
    {
      format: "wav",
      label: "WAV",
      rates: [16000, 22050, 24000, 32000, 44100, 48000],
      defaultRate: 8000,
      bitrates: [],
      defaultBitrate: null,
    },
  ],
  tags: () => ({
    brackets: ["square"],
    open: true,
    kinds: ["sound", "delivery"],
    example: "[laughs]",
    hint: "A simulated endpoint takes any tag in square brackets, and speaks none of them.",
  }),
  billsFailures: false,
  cloning: null,
  // the fake reads faster or slower, so the demo shows the sent kind
  speed: () => ({ min: 0.5, max: 2 }),
  models: [SIMULATED_SPEECH_MODEL],
};
