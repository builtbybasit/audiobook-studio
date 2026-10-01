// What the Voices tab's clone and keep forms hold a pick of samples to, read from the endpoint's
// provider (`cloning`) rather than written for any one of them.
//
// The server refuses a sample outside what the provider takes, with the file's own name
// (`server/voices/clone.ts`), in the words of `lib/voiceSamples.ts`, which the page says too. The
// page holds the same limits up front so a pick is fixed before anything is sent: the picker offers
// only the formats the provider takes, a pick past the most it takes is cut and the cut said, and a
// file too large, or named as a format the provider does not take, blocks the button with its name.
// The server still reads each file's first bytes and is the one that decides; a name is only a
// guess, so a file named as no known format is left for it to judge.
import type { CloneSupport, SampleFormat } from "@/lib/providers";
import {
  formatsSaid,
  MAX_SAMPLES_BYTES,
  maxSampleBytesOf,
  maxSamplesOf,
  sizeSaid,
  tooLargeSaid,
  tooMuchSaid,
  wrongFormatSaid,
} from "@/lib/voiceSamples";

/** One sample as a form holds it: the file, and what is said in it when the person gave that. */
export interface SampleRow {
  file: File;
  transcript: string;
}

/** The names a sample of each format goes by; Opus is as often in an Ogg file as on its own. */
const EXTENSIONS: Record<SampleFormat, readonly string[]> = {
  wav: [".wav"],
  mp3: [".mp3"],
  m4a: [".m4a"],
  opus: [".opus", ".ogg"],
  flac: [".flac"],
};

/** The file picker's `accept`: every name a format the provider takes goes by. */
export const acceptOf = (cloning: CloneSupport): string =>
  cloning.formats.flatMap((f) => EXTENSIONS[f]).join(",");

/**
 * The limits in one short line beside the picker: "Up to 20 files, 20 MB each · WAV, MP3, M4A,
 * Opus or FLAC", or for a provider that takes one, "One file, up to 10 MB · WAV or MP3".
 */
export function limitsSaid(cloning: CloneSupport): string {
  const max = maxSamplesOf(cloning);
  const size = sizeSaid(maxSampleBytesOf(cloning));
  const count = max === 1 ? `One file, up to ${size}` : `Up to ${max} files, ${size} each`;
  return `${count} · ${formatsSaid(cloning.formats)}`;
}

/** The samples picked, up to the most one voice is made from, and how many were not. */
export function pickOf<T>(
  items: readonly T[],
  cloning: CloneSupport,
): { samples: T[]; leftOut: number } {
  const samples = items.slice(0, maxSamplesOf(cloning));
  return { samples, leftOut: items.length - samples.length };
}

/** What the page says of a pick cut short: "Only the first 20 are used: 3 left out." */
export const leftOutSaid = (leftOut: number, cloning: CloneSupport): string =>
  maxSamplesOf(cloning) === 1
    ? `Only one sample is used: ${leftOut} left out.`
    : `Only the first ${maxSamplesOf(cloning)} are used: ${leftOut} left out.`;

/** The format a file's name says it is, or null when its name says none this app knows. */
export function formatOfName(name: string): SampleFormat | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot).toLowerCase();
  for (const [format, names] of Object.entries(EXTENSIONS))
    if (names.includes(ext)) return format as SampleFormat;
  return null;
}

/**
 * Why these samples cannot be sent as they are, naming the first file at fault, or null when
 * nothing stops them: a file larger than the provider takes, one named as a format it does not
 * make a voice from, or all of them past what the server reads in one go. `who` is what the
 * sentence calls the provider.
 */
export function pickProblem(
  samples: readonly File[],
  cloning: CloneSupport,
  who: string,
): string | null {
  for (const f of samples) {
    if (f.size > maxSampleBytesOf(cloning)) return `${tooLargeSaid(f.name, cloning, who)}.`;
    const format = formatOfName(f.name);
    if (format && !cloning.formats.includes(format))
      return `${wrongFormatSaid(f.name, format, who)}. Use ${formatsSaid(cloning.formats)}.`;
  }
  if (samples.reduce((n, f) => n + f.size, 0) > MAX_SAMPLES_BYTES) return `${tooMuchSaid()}.`;
  return null;
}

/** Whether a provider that needs a transcript of each sample is still owed one for some row. */
export const transcriptsMissing = (rows: readonly SampleRow[], cloning: CloneSupport): boolean =>
  cloning.transcript === "required" && rows.some((r) => !r.transcript.trim());

/** The rows as the store's request takes them: the files, and the transcripts beside them. */
export const requestOf = (rows: readonly SampleRow[]) => ({
  samples: rows.map((r) => r.file),
  transcripts: rows.map((r) => r.transcript.trim()),
});
