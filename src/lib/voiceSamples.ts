// The app's own ceiling on voice samples above every provider's `cloning`, and the wording both
// page and server use for a refused pick.
import type { CloneSupport, SampleFormat } from "@/lib/providers/types";

/** Fish's twenty. */
export const MAX_VOICE_SAMPLES = 20;
export const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;
/** All of one voice's samples together. */
export const MAX_SAMPLES_BYTES = 100 * 1024 * 1024;
/** A minute of speech is under two hundred words. */
export const MAX_TRANSCRIPT_CHARS = 1000;

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

/** Binary units, as every limit here is set in. */
export const sizeSaid = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${+(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

export const maxSamplesOf = (cloning: CloneSupport): number =>
  Math.min(cloning.maxSamples, MAX_VOICE_SAMPLES);

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

export const noTranscriptSaid = (name: string, who = "this provider"): string =>
  `Say what is said in ${name}: ${who} needs a transcript of each sample`;

export const transcriptTooLongSaid = (name: string): string =>
  `The transcript of ${name} runs past ${MAX_TRANSCRIPT_CHARS} characters`;

export const wrongFormatSaid = (
  name: string,
  format: SampleFormat,
  who = "this provider",
): string =>
  `${name} is ${SAMPLE_FORMAT_NAME[format]} audio, which ${who} does not make a voice from`;

/** "Use WAV, MP3 or M4A audio." */
export const formatsHint = (cloning: CloneSupport): string =>
  `Use ${formatsSaid(cloning.formats)} audio.`;
