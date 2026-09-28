// What the Voices tab's clone and keep forms hold a pick of samples to, read from the endpoint's
// provider (`cloning`) rather than written for any one of them.
//
// The server refuses a sample outside what the provider takes, with the file's own name (`clipsOf`
// in `server/routes/endpoints.ts`). The page holds the same limits up front so a pick is fixed
// before anything is sent: the picker offers only the formats the provider takes, a pick past the
// most it takes is cut and the cut said, and a file too large, or named as a format the provider
// does not take, blocks the button with its name. The server still reads each file's first bytes
// and is the one that decides; a name is only a guess, so a file named as no known format is left
// for it to judge.
import type { CloneSupport, RecordingFormat } from "@/lib/providers";
import { MAX_CLONE_CLIPS } from "@/lib/endpointShapes";

/** The names a sample of each format goes by; Opus is as often in an Ogg file as on its own. */
const EXTENSIONS: Record<RecordingFormat, readonly string[]> = {
  wav: [".wav"],
  mp3: [".mp3"],
  m4a: [".m4a"],
  opus: [".opus", ".ogg"],
  flac: [".flac"],
};

const FORMAT_NAME: Record<RecordingFormat, string> = {
  wav: "WAV",
  mp3: "MP3",
  m4a: "M4A",
  opus: "Opus",
  flac: "FLAC",
};

/** The file picker's `accept`: every name a format the provider takes goes by. */
export const acceptOf = (cloning: CloneSupport): string =>
  cloning.formats.flatMap((f) => EXTENSIONS[f]).join(",");

/** "WAV, MP3, M4A, Opus or FLAC" — the formats the provider takes, as the server says them. */
export const formatsSaid = (formats: readonly RecordingFormat[]): string => {
  const names = formats.map((f) => FORMAT_NAME[f]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
};

/** "20 MB", "512 KB" — the way the server says a limit, so the page and a refusal agree. */
export const sizeSaid = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${+(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/** The most samples one voice is made from here: the provider's, and never past the app's own. */
export const maxClipsOf = (cloning: CloneSupport): number =>
  Math.min(cloning.maxClips, MAX_CLONE_CLIPS);

/**
 * One sentence on what a pick may be, under the provider's advice: "WAV, MP3, M4A, Opus or FLAC;
 * up to 20 samples of up to 20 MB each." or, for a provider that takes one, "One sample, WAV or
 * MP3, of up to 10 MB."
 */
export function limitsSaid(cloning: CloneSupport): string {
  const max = maxClipsOf(cloning);
  const size = sizeSaid(cloning.maxClipBytes);
  return max === 1
    ? `One sample, ${formatsSaid(cloning.formats)}, of up to ${size}.`
    : `${formatsSaid(cloning.formats)}; up to ${max} samples of up to ${size} each.`;
}

/** The files picked, up to the most one voice is made from, and how many were not. */
export function pickOf(
  files: readonly File[],
  cloning: CloneSupport,
): { clips: File[]; leftOut: number } {
  const clips = files.slice(0, maxClipsOf(cloning));
  return { clips, leftOut: files.length - clips.length };
}

/** What the page says of a pick cut short: "Only the first 20 are used: 3 left out." */
export const leftOutSaid = (leftOut: number, cloning: CloneSupport): string =>
  maxClipsOf(cloning) === 1
    ? `Only one sample is used: ${leftOut} left out.`
    : `Only the first ${maxClipsOf(cloning)} are used: ${leftOut} left out.`;

/** The format a file's name says it is, or null when its name says none this app knows. */
export function formatOfName(name: string): RecordingFormat | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot).toLowerCase();
  for (const [format, names] of Object.entries(EXTENSIONS))
    if (names.includes(ext)) return format as RecordingFormat;
  return null;
}

/**
 * Why these samples cannot be sent as they are, naming the first file at fault, or null when
 * nothing stops them: a file larger than the provider takes, or one named as a format it does not
 * make a voice from. `who` is what the sentence calls the provider.
 */
export function pickProblem(
  clips: readonly File[],
  cloning: CloneSupport,
  who: string,
): string | null {
  for (const f of clips) {
    if (f.size > cloning.maxClipBytes)
      return `${f.name} is larger than ${sizeSaid(cloning.maxClipBytes)}, the most ${who} takes for one sample.`;
    const format = formatOfName(f.name);
    if (format && !cloning.formats.includes(format))
      return `${f.name} is ${FORMAT_NAME[format]} audio, which ${who} does not make a voice from. Use ${formatsSaid(cloning.formats)}.`;
  }
  return null;
}
