// Sample limits for the Voices tab's clone and keep forms, from the provider's `cloning`. They
// mirror the server's (`server/voices/clone.ts`) so a pick is fixed before sending; the server
// still sniffs each file and decides, so a file with an unknown extension is left to it.
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

/** A sample file and, if given, its transcript. */
export interface SampleRow {
  file: File;
  transcript: string;
  /** cut in the form, so a transcript of the whole file may no longer match */
  trimmed?: boolean;
}

/** Opus is as often in an Ogg file as on its own. */
const EXTENSIONS: Record<SampleFormat, readonly string[]> = {
  wav: [".wav"],
  mp3: [".mp3"],
  m4a: [".m4a"],
  opus: [".opus", ".ogg"],
  flac: [".flac"],
};

/** The file picker's `accept`. */
export const acceptOf = (cloning: CloneSupport): string =>
  cloning.formats.flatMap((f) => EXTENSIONS[f]).join(",");

/** E.g. "Up to 20 files, 20 MB each · WAV, MP3, M4A, Opus or FLAC". */
export function limitsSaid(cloning: CloneSupport): string {
  const max = maxSamplesOf(cloning);
  const size = sizeSaid(maxSampleBytesOf(cloning));
  const count = max === 1 ? `One file, up to ${size}` : `Up to ${max} files, ${size} each`;
  return `${count} · ${formatsSaid(cloning.formats)}`;
}

/** The pick capped at the provider's maximum, and how many were left out. */
export function pickOf<T>(
  items: readonly T[],
  cloning: CloneSupport,
): { samples: T[]; leftOut: number } {
  const samples = items.slice(0, maxSamplesOf(cloning));
  return { samples, leftOut: items.length - samples.length };
}

/** "Only the first 20 are used: 3 left out." */
export const leftOutSaid = (leftOut: number, cloning: CloneSupport): string =>
  maxSamplesOf(cloning) === 1
    ? `Only one sample is used: ${leftOut} left out.`
    : `Only the first ${maxSamplesOf(cloning)} are used: ${leftOut} left out.`;

/** null when the extension is none this app knows. */
export function formatOfName(name: string): SampleFormat | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot).toLowerCase();
  for (const [format, names] of Object.entries(EXTENSIONS))
    if (names.includes(ext)) return format as SampleFormat;
  return null;
}

/** Why these samples can't be sent (too large, wrong format, over the total), naming the first
 *  file at fault; null when fine. `who` names the provider in the sentence. */
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

/** A provider needing per-sample transcripts is still owed one. */
export const transcriptsMissing = (rows: readonly SampleRow[], cloning: CloneSupport): boolean =>
  cloning.transcript === "required" && rows.some((r) => !r.transcript.trim());

export const requestOf = (rows: readonly SampleRow[]) => ({
  samples: rows.map((r) => r.file),
  transcripts: rows.map((r) => r.transcript.trim()),
});
