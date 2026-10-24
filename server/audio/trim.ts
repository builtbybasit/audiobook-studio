// The silence a voice leaves before and after its words, cut as a clip lands, so the gap between
// lines is the book's pacing and nothing more. A `[[pause]]` at a line's edge is kept.
import type { AudioFormat, Pacing, Segment } from "@/types";
import { pauseSeconds } from "@/lib/expressions";
import { ffmpegWav } from "~/audio/ffmpeg";
import { probeClip } from "~/audio/probe";

/** seconds of silence to leave at each end, beyond `MARGIN` */
export interface Edges {
  start: number;
  end: number;
}

/** Throws when it cannot; the caller keeps the clip as it came. */
export type TrimSilence = (
  bytes: Uint8Array,
  keep: Edges,
  signal: AbortSignal,
) => Promise<Uint8Array>;

// left on each end so a breath or a soft first consonant is not clipped
const MARGIN = 0.04;
// chosen against the clips of four books: their padding sits below it, their words above
const QUIET = "-45dB";
// less than this is not worth rewriting an MP3 or Opus clip as WAV
const MIN_CUT = 0.01;

const trimStart = (keep: number): string =>
  `silenceremove=start_periods=1:start_threshold=${QUIET}:start_silence=${(MARGIN + keep).toFixed(3)}:detection=peak:window=0.01`;

/** silenceremove trims only the start well, so the end is trimmed reversed */
export const trimFilter = (keep: Edges): string =>
  [trimStart(keep.start), "areverse", trimStart(keep.end), "areverse"].join(",");

export const ffmpegTrim =
  (bin = "ffmpeg"): TrimSilence =>
  (bytes, keep, signal) =>
    ffmpegWav(bin, ["-af", trimFilter(keep)], bytes, signal);

/** Silence the line asks for at its start and end, in seconds. */
export function edgePauses(s: Pick<Segment, "text" | "expressions">, pacing: Pacing): Edges {
  const keep = { start: 0, end: 0 };
  for (const a of s.expressions ?? []) {
    if (a.kind !== "pause" || a.omitted) continue;
    if (!s.text.slice(0, a.at).trim()) keep.start += pauseSeconds(a, pacing);
    else if (!s.text.slice(a.at).trim()) keep.end += pauseSeconds(a, pacing);
  }
  return keep;
}

interface Audio {
  bytes: Uint8Array;
  format: AudioFormat;
  duration: number;
}

/** The clip with its ends trimmed, as WAV; null when there is nothing to cut, or only silence. */
export async function trimClip(
  trim: TrimSilence,
  clip: Audio,
  keep: Edges,
  signal: AbortSignal,
): Promise<Audio | null> {
  const bytes = await trim(clip.bytes, keep, signal);
  const { duration } = await probeClip(bytes, "wav");
  return duration > 0 && clip.duration - duration >= MIN_CUT
    ? { bytes, format: "wav", duration }
    : null;
}
