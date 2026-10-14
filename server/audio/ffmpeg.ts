// Audio through the local ffmpeg: bytes on stdin, a 16-bit WAV on stdout. ffmpeg reads the
// container off the bytes, so the input needs no format flag.
import { readWavHeader } from "~/providers/wav";

/**
 * ffmpeg cannot seek back over a pipe, so it leaves 0xFFFFFFFF in both WAV sizes; this fills them
 * in, or a reader would read past the end.
 */
function sized<T extends Uint8Array>(wav: T): T {
  const { start } = readWavHeader(wav);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  view.setUint32(4, wav.byteLength - 8, true);
  view.setUint32(start - 4, wav.byteLength - start, true);
  return wav;
}

/** `args` go between the input and the output. Throws with ffmpeg's last words; a cancel kills it. */
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
 * 16 kHz mono WAV, the rate speech-to-text works at. Fermion Phonon's CUDA build refuses any other
 * ("this runtime requires 16 kHz"). Word times are unchanged.
 */
export type SpeechRate = (
  bytes: Uint8Array,
  signal: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export const ffmpegSpeechRate =
  (bin = "ffmpeg"): SpeechRate =>
  (bytes, signal) =>
    ffmpegWav(bin, ["-ar", "16000", "-ac", "1"], bytes, signal);
