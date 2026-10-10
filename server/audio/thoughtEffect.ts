// The sound a `thought` line is given as its clip lands: a voice heard from inside a head rather
// than across a room — thinned and boxed in, the presence taken down, held together, and a small
// room ringing around it.
//
// It is applied once, when the clip arrives, and kept in the file (`jobs/narration.ts`), so the
// player, the Listen page, a check by ear and a build all hear the same thing and nothing has to
// remember to apply it later. The clip records that it carries it (`SegmentAudio.effect`).
//
// It is a port, like the encoder: ffmpeg's in a running server, and nothing at all in a test's
// library that is handed none, which narrates thoughts as the voice made them.
//
// What comes out is always a WAV at the clip's own rate, whatever went in: re-encoding an MP3 or an
// Opus clip would lose a second generation and mean choosing a bitrate, and a clip's format is only
// its extension (`audio/files.ts`) — a book already plays and builds from a mix of the three.
import type { AudioFormat } from "@/types";
import { ffmpegWav } from "~/audio/ffmpeg";

/**
 * Bytes in, processed WAV bytes out. Throws when it cannot; the caller keeps the clip as it came.
 */
export type ThoughtEffect = (
  bytes: Uint8Array,
  format: AudioFormat,
  signal: AbortSignal,
) => Promise<Uint8Array>;

/**
 * The chain, as one ffmpeg filter: highpass 220 Hz, lowpass 6 kHz, −4 dB at 2.5 kHz, 3:1
 * compression from −20 dB, a small room, −1 dB. ffmpeg has no Freeverb, so the room is four early
 * reflections. Chosen by ear (2026-10-10): the first, gentler chain was not audible as a thought.
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

/** The effect run by an ffmpeg on this machine: the clip on stdin, a 16-bit WAV on stdout. */
export const ffmpegThoughtEffect =
  (bin = "ffmpeg"): ThoughtEffect =>
  (bytes, _format, signal) =>
    ffmpegWav(bin, ["-af", THOUGHT_FILTER], bytes, signal);
