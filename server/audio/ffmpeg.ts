// Audio through the ffmpeg on this machine: bytes in on stdin, a 16-bit WAV out on stdout. What the
// thought effect (`thoughtEffect.ts`) and a recording sent to be transcribed (`speechRate`) are made
// with, each a port the server fills at boot when it found one.
//
// ffmpeg reads the container off the bytes, so the format that came in needs no flag; no metadata,
// so what comes back is a header and the samples.
import { readWavHeader } from "~/providers/wav";

/**
 * A WAV written to a pipe, with its sizes filled in. ffmpeg cannot seek back over a pipe to write
 * them, so it leaves 0xFFFFFFFF in both, and a reader that believes the `data` size reads past the end.
 */
function sized<T extends Uint8Array>(wav: T): T {
  const { start } = readWavHeader(wav);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  view.setUint32(4, wav.byteLength - 8, true);
  view.setUint32(start - 4, wav.byteLength - start, true);
  return wav;
}

/**
 * `bytes` run through ffmpeg with `args` between the input and the output: a 16-bit WAV, its sizes
 * true. Throws, with ffmpeg's last words, when it fails; a cancel kills it.
 */
export async function ffmpegWav(
  bin: string,
  args: readonly string[],
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const proc = Bun.spawn(
    [
      bin,
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      ...args,
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
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal.aborted) throw signal.reason;
    if (code !== 0) {
      const why = stderr.trim().split("\n").slice(-3).join(" ").trim();
      throw new Error(`ffmpeg failed${why ? `: ${why}` : ""}`);
    }
    return sized(new Uint8Array(out));
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * A recording as speech-to-text hears it: 16 kHz mono WAV. Every such model works at that rate, and
 * Fermion Phonon's CUDA build refuses any other ("this runtime requires 16 kHz"), where its Mac build
 * converts for itself. The words keep their times: only the samples between them change.
 */
export type SpeechRate = (
  bytes: Uint8Array,
  signal: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export const ffmpegSpeechRate =
  (bin = "ffmpeg"): SpeechRate =>
  (bytes, signal) =>
    ffmpegWav(bin, ["-ar", "16000", "-ac", "1"], bytes, signal);
