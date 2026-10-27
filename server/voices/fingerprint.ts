// A speaker fingerprint per kept sample: ECAPA (SpeechBrain) run by `fingerprint.py` under uv, one
// process for a batch so the model loads once. Not probed at boot: the first use downloads torch
// (about 1 GB) and the model, so it waits until someone opens the voice comparison.
import { fileURLToPath } from "node:url";

import { RETRY_MS } from "~/audio/effects";

export const FINGERPRINT_MODEL = "speechbrain/spkrec-ecapa-voxceleb";
export const SCRIPT = fileURLToPath(new URL("./fingerprint.py", import.meta.url));
// pinned together: they resolve on Python 3.13 for macOS arm64 (14+) and Windows x64
export const SPEECHBRAIN = ["speechbrain==1.1.2", "torch==2.14.1", "torchaudio==2.11.0"];

export interface VoiceFingerprinter {
  /** Null when fingerprinting can run, else why not. Only a yes is remembered. */
  unavailable(): Promise<string | null>;
  /**
   * One unit-length vector per path, in order; null for a file that can't be read or is too short.
   * Throws the script's one-line reason when nothing could run.
   */
  fingerprint(paths: readonly string[], signal: AbortSignal): Promise<(Float32Array | null)[]>;
}

export const NO_UV =
  "comparing voices needs uv (docs.astral.sh/uv), which was not found — install it, then try again";

function whyNot(e: unknown): string {
  const err = e as { code?: string; name?: string; message?: string };
  if (err?.code === "ENOENT") return NO_UV;
  if (err?.name === "TimeoutError")
    return "SpeechBrain took too long to load (its first download is about 1 GB) — try again";
  return `SpeechBrain could not be loaded: ${err?.message ?? String(e)}`;
}

export function ecapaFingerprinter(
  opts: { uv?: string; ffmpeg?: string } = {},
): VoiceFingerprinter {
  const { uv = "uv", ffmpeg = "ffmpeg" } = opts;

  // paths go on stdin: hundreds of them overrun the Windows command-line limit
  const run = async (args: string[], input: string, signal: AbortSignal): Promise<string> => {
    const cmd = [uv, "run", "-q", "--no-project", "--python", "3.13"];
    const proc = Bun.spawn(
      [...cmd, ...SPEECHBRAIN.flatMap((p) => ["--with", p]), "python", "-I", ...args],
      { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" },
    );
    const kill = (): void => proc.kill();
    if (signal.aborted) kill();
    signal.addEventListener("abort", kill, { once: true });
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (signal.aborted) throw signal.reason;
      if (code !== 0)
        throw new Error(
          err.trim().split("\n").at(-1)?.trim() || `fingerprint.py exited with ${code}`,
        );
      return out;
    } finally {
      signal.removeEventListener("abort", kill);
    }
  };

  let probe: Promise<string | null> | undefined;
  let failedAt = 0;
  const unavailable = (): Promise<string | null> => {
    if (!probe || (failedAt && Date.now() - failedAt > RETRY_MS)) {
      failedAt = 0;
      probe = run(
        ["-c", "import speechbrain.inference.speaker"],
        "",
        AbortSignal.timeout(900_000),
      ).then(
        () => null,
        (e: unknown) => {
          failedAt = Date.now();
          return whyNot(e);
        },
      );
    }
    return probe;
  };

  return {
    unavailable,
    async fingerprint(paths, signal) {
      if (!paths.length) return [];
      const out = await run([SCRIPT, ffmpeg, FINGERPRINT_MODEL], paths.join("\n"), signal);
      // a library may print to stdout too; the answers are the lines that are arrays or null
      const vectors = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("[") || l === "null")
        .map((l) => (l === "null" ? null : Float32Array.from(JSON.parse(l) as number[])));
      if (vectors.length !== paths.length)
        throw new Error(`fingerprint.py gave ${vectors.length} vectors for ${paths.length} files`);
      return vectors;
    },
  };
}
