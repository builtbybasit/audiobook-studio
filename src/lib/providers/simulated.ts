// A speech endpoint, scripting profile or transcription endpoint that answers from this server and
// never the network.
//
// It is picked the way every other provider is, by its base URL: `simulated://…` is no host, so
// nothing can be sent anywhere by mistake. Its requests are priced at its rate card like any
// other, so a budget can be run out and a cost read, but every row is marked simulated: nothing
// was billed. What it stands in for is the server's own fakes — a quiet tone per line, a script
// read from the prose's punctuation, and one fixed sentence heard in every recording — held to the
// endpoint's `latency` and `failRate`, so a run on one moves, and fails, the way a run on a real
// endpoint can.
import type { Voice } from "@/types";
import type { SpeechProviderShape } from "@/lib/providers/types";

/** The base URL the Simulated presets fill in. Any `simulated:` URL is one. */
export const SIMULATED_BASE_URL = "simulated://local";

/** Whether a base URL names the simulated provider rather than a host. */
export const isSimulated = (baseUrl: string): boolean => /^simulated:/i.test(baseUrl.trim());

/** The model a simulated endpoint or profile names, for the history and the ledger. */
export const SIMULATED_SPEECH_MODEL = "simulated-tts";
export const SIMULATED_SCRIPTING_MODEL = "simulated-script";
export const SIMULATED_TRANSCRIPTION_MODEL = "simulated-stt";

/** What "Fetch from server" lists for a simulated endpoint: a few voices, each its own pitch. */
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
  // nothing is sent, so there is no path to show
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
  models: [SIMULATED_SPEECH_MODEL],
};
