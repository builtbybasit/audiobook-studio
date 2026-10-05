// The speech-to-text presets: what "Start from a preset…" offers a transcription endpoint. Every
// one is a server answering OpenAI's `POST /audio/transcriptions`, the only request the server's
// transcription provider makes, priced per minute of audio sent. A hosted rate is the provider's
// published card on the date its note gives.
import { presetPricing, type TranscriptionPreset } from "@/lib/presets/preset";
import { SIMULATED_BASE_URL, SIMULATED_TRANSCRIPTION_MODEL } from "@/lib/providers";

export const TRANSCRIPTION_PRESETS: TranscriptionPreset[] = [
  {
    // first, as on the other kinds: the one that works without a server or an account
    id: "simulated",
    group: "Simulated",
    label: "Simulated (free)",
    hint: "one fixed sentence, answered by this server",
    note:
      "Answered by this server and never the network: every recording is heard as the same " +
      "sentence, so the Transcribe button can be tried without a server. Nothing is billed and " +
      "no key is needed.",
    apply: {
      name: "Simulated (free)",
      baseUrl: SIMULATED_BASE_URL,
      model: SIMULATED_TRANSCRIPTION_MODEL,
      needsKey: false,
      perMinute: 0,
      concurrency: 4,
      pricing: presetPricing(),
    },
  },
  {
    id: "fermion-phonon",
    group: "On your machine",
    label: "Fermion Phonon (local)",
    hint: "phonon-2 on :8001, English only",
    note:
      "Started with `fermion serve phonon-2 --port 8001`; port 8000 is OmniVoice's. Phonon " +
      "hears English only. Nothing is billed.",
    apply: {
      name: "Fermion Phonon (local)",
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "phonon-2",
      needsKey: false,
      perMinute: 0,
      // a local server has no published limit: what it holds depends on the machine and the model
      concurrency: 2,
      pricing: presetPricing(),
    },
  },
  {
    id: "compatible",
    group: "On your machine",
    label: "OpenAI-compatible server",
    hint: "any server answering /audio/transcriptions",
    note: "Fill in the server's address and the model it serves. Nothing is billed.",
    apply: {
      name: "Speech to text (local)",
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "",
      needsKey: false,
      perMinute: 0,
      concurrency: 2,
      pricing: presetPricing(),
    },
  },
  {
    id: "openai-whisper",
    group: "OpenAI",
    label: "OpenAI · Whisper",
    hint: "whisper-1, with the time of every word",
    note:
      "$0.006 per minute of audio sent. whisper-1 is the OpenAI model that answers with word " +
      "timestamps; gpt-4o-transcribe answers with the text alone. Rate as published on " +
      "5 October 2026.",
    apply: {
      name: "OpenAI · Whisper",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      needsKey: true,
      perMinute: 0.006,
      // no documented concurrency; Tier 1 is 500 RPM, which four recordings at once stay well under
      // (https://developers.openai.com/api/docs/models/whisper-1)
      concurrency: 4,
      pricing: presetPricing(),
    },
  },
];
