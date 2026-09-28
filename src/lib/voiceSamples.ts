// What a voice sample may be, said once for the page and the server alike.
//
// A sample is any audio of one person speaking — recorded, or downloaded — that a voice is cloned
// from and then kept with. Each provider says what it takes in its `cloning` (`lib/providers/`);
// this is the app's own ceiling above all of them, and the words both sides use for a limit, so the
// page's note before a pick is sent and the server's refusal after it say the same thing.
import type { CloneSupport, SampleFormat } from "@/lib/providers/types";

/** The most samples one voice is made from or kept with, whatever its provider: Fish's twenty. */
export const MAX_VOICE_SAMPLES = 20;
/** The most one sample may be, in bytes, whatever its provider. */
export const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;
/** The most one voice's samples may come to together, in bytes. */
export const MAX_SAMPLES_BYTES = 100 * 1024 * 1024;

/** What each format is called in a sentence. */
export const SAMPLE_FORMAT_NAME: Record<SampleFormat, string> = {
  wav: "WAV",
  mp3: "MP3",
  m4a: "M4A",
  opus: "Opus",
  flac: "FLAC",
};

/** "WAV, MP3 or M4A" */
export function formatsSaid(formats: readonly SampleFormat[]): string {
  const names = formats.map((f) => SAMPLE_FORMAT_NAME[f]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
}

/** "20 MB", "512 KB", in the binary units every limit here is set in. */
export const sizeSaid = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${+(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/** The most samples one voice is made from on this provider, never past the app's own. */
export const maxSamplesOf = (cloning: CloneSupport): number =>
  Math.min(cloning.maxSamples, MAX_VOICE_SAMPLES);

/** The most one sample may be on this provider, never past the app's own. */
export const maxSampleBytesOf = (cloning: CloneSupport): number =>
  Math.min(cloning.maxSampleBytes, MAX_SAMPLE_BYTES);

// ---------- what is said of a pick the provider will not take ----------

export const tooManySaid = (cloning: CloneSupport): string =>
  maxSamplesOf(cloning) === 1
    ? "Use one sample: this provider makes a voice from a single file"
    : `Use at most ${maxSamplesOf(cloning)} samples`;

export const tooLargeSaid = (name: string, cloning: CloneSupport, who = "this provider"): string =>
  `${name} is larger than ${sizeSaid(maxSampleBytesOf(cloning))}, the most ${who} takes for one sample`;

export const tooMuchSaid = (): string =>
  `The samples come to more than ${sizeSaid(MAX_SAMPLES_BYTES)}`;

export const wrongFormatSaid = (
  name: string,
  format: SampleFormat,
  who = "this provider",
): string =>
  `${name} is ${SAMPLE_FORMAT_NAME[format]} audio, which ${who} does not make a voice from`;

/** The hint under a format refusal: "Use WAV, MP3 or M4A audio." */
export const formatsHint = (cloning: CloneSupport): string =>
  `Use ${formatsSaid(cloning.formats)} audio.`;
