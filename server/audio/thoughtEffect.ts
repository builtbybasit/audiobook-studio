// The sound a `thought` line is given as its clip lands: a voice heard from inside a head rather
// than across a room — a little rumble and air taken off, the presence softened, gently held
// together, and a short room around it.
//
// It is applied once, when the clip arrives, and kept in the file (`jobs/narration.ts`), so the
// player, the Listen page, a check by ear and a build all hear the same thing and nothing has to
// remember to apply it later. The clip records that it carries it (`SegmentAudio.effect`).
//
// It is a port, like the encoders: ffmpeg when the server found one at boot, and nothing at all
// otherwise — the test suite and a machine without ffmpeg narrate thoughts as the voice made them.
//
// What comes out is always a WAV at the clip's own rate, whatever went in: re-encoding an MP3 or an
// Opus clip would lose a second generation and mean choosing a bitrate, and a clip's format is only
// its extension (`audio/files.ts`) — a book already plays and builds from a mix of the three.
import type { AudioFormat } from "@/types";
import { readWavHeader } from "~/providers/wavEncoder";

/**
 * Bytes in, processed WAV bytes out. Throws when it cannot; the caller keeps the clip as it came.
 */
export type ThoughtEffect = (
  bytes: Uint8Array,
  format: AudioFormat,
  signal: AbortSignal,
) => Promise<Uint8Array>;

/**
 * The chain, as one ffmpeg filter: highpass 90 Hz, −1.5 dB at 4 kHz, lowpass 9 kHz, 2:1 compression
 * from −18 dB, a short room, −1 dB. ffmpeg has no Freeverb, so the room is three quiet early
 * reflections.
 */
// ponytail: aecho taps approximate a reverb; `afir` with a small room impulse response is the upgrade
export const THOUGHT_FILTER = [
  "highpass=f=90",
  "equalizer=f=4000:t=q:w=1:g=-1.5",
  "lowpass=f=9000",
  "acompressor=threshold=-18dB:ratio=2:attack=15:release=120",
  "aecho=in_gain=1:out_gain=0.9:delays=23|37|53:decays=0.12|0.08|0.05",
  "volume=-1dB",
].join(",");

/**
 * A WAV written to a pipe, with its sizes filled in. ffmpeg cannot seek back over a pipe to write
 * them, so it leaves 0xFFFFFFFF in both, and a reader that believes the `data` size reads past the end.
 */
function sized(wav: Uint8Array): Uint8Array {
  const { start } = readWavHeader(wav);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  view.setUint32(4, wav.byteLength - 8, true);
  view.setUint32(start - 4, wav.byteLength - start, true);
  return wav;
}

/** The effect run by an ffmpeg on this machine: the clip on stdin, a 16-bit WAV on stdout. */
export function ffmpegThoughtEffect(bin = "ffmpeg"): ThoughtEffect {
  return async (bytes, _format, signal) => {
    // ffmpeg reads the container off the bytes, so the format the clip came in needs no flag; no
    // metadata, so what comes back is a header and the samples
    const proc = Bun.spawn(
      [
        bin,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-af",
        THOUGHT_FILTER,
        "-map_metadata",
        "-1",
        "-bitexact",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      { stdin: bytes, stdout: "pipe", stderr: "pipe" },
    );
    const abort = (): void => proc.kill();
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const [out, stderr, code] = await Promise.all([
        new Response(proc.stdout).bytes(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (signal.aborted) throw signal.reason;
      if (code !== 0) {
        const why = stderr.trim().split("\n").slice(-3).join(" ").trim();
        throw new Error(`ffmpeg could not apply it${why ? `: ${why}` : ""}`);
      }
      return sized(out);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}
