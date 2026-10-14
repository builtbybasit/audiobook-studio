// The ffmpeg `thought` sound, used where Pedalboard cannot run (no uv). Baked into the clip as it
// lands (sound `"ffmpeg"`, the voice's file kept as raw so a Re-apply can redo it). Always WAV at
// the clip's rate: re-encoding MP3 or Opus would lose a generation and need a bitrate.
import type { AudioFormat } from "@/types";
import { ffmpegWav } from "~/audio/ffmpeg";

/** Throws when it cannot; the caller keeps the clip as it came. */
export type ThoughtEffect = (
  bytes: Uint8Array,
  format: AudioFormat,
  signal: AbortSignal,
) => Promise<Uint8Array>;

/**
 * Chosen by ear; a gentler chain was not audible as a thought. ffmpeg has no Freeverb, so the room
 * is four early reflections.
 */
// ponytail: aecho taps approximate a reverb; `afir` with a small room impulse response is the upgrade
export const THOUGHT_FILTER = [
  "highpass=f=220",
  "lowpass=f=6000",
  "equalizer=f=2500:t=q:w=1:g=-4",
  "acompressor=threshold=-20dB:ratio=3",
  "aecho=in_gain=0.9:out_gain=0.85:delays=40|75|115|160:decays=0.35|0.25|0.16|0.1",
  "volume=-1dB",
].join(",");

/** The clip on stdin, a 16-bit WAV on stdout. */
export const ffmpegThoughtEffect =
  (bin = "ffmpeg"): ThoughtEffect =>
  (bytes, _format, signal) =>
    ffmpegWav(bin, ["-af", THOUGHT_FILTER], bytes, signal);
