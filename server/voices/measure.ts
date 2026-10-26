// A voice's pitch, clarity and intonation from its kept samples: Praat (parselmouth) run by
// `measure.py` under uv, one process per measure. Pinned to Python 3.13: newer ones have no
// parselmouth wheel and pip spends minutes compiling Praat. Without uv nothing is measured.
import { fileURLToPath } from "node:url";

import type { MeasuredVoice } from "@/types";
import { RETRY_MS } from "~/audio/effects";

export const SCRIPT = fileURLToPath(new URL("./measure.py", import.meta.url));
export const PARSELMOUTH = "praat-parselmouth==0.4.7";

export interface VoiceMeter {
  /** Null when measuring can run, else why not. Only a yes is remembered. */
  unavailable(): Promise<string | null>;
  /** All the files measured as one recording; throws the script's one-line reason. */
  measure(paths: readonly string[], signal: AbortSignal): Promise<MeasuredVoice>;
}

export const NO_UV =
  "measuring needs uv (docs.astral.sh/uv), which was not found — install it, then try again";

function whyNot(e: unknown): string {
  const err = e as { code?: string; name?: string; message?: string };
  if (err?.code === "ENOENT") return NO_UV;
  if (err?.name === "TimeoutError")
    return "Praat took too long to load (its first download may be slow) — try again";
  return `Praat could not be loaded: ${err?.message ?? String(e)}`;
}

export function parselmouthMeter(opts: { uv?: string; ffmpeg?: string } = {}): VoiceMeter {
  const { uv = "uv", ffmpeg = "ffmpeg" } = opts;

  const run = async (args: string[], signal: AbortSignal): Promise<string> => {
    const cmd = [uv, "run", "-q", "--no-project", "--python", "3.13", "--with", PARSELMOUTH];
    const proc = Bun.spawn([...cmd, "python", "-I", ...args], { stdout: "pipe", stderr: "pipe" });
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
        throw new Error(err.trim().split("\n").at(-1)?.trim() || `measure.py exited with ${code}`);
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
      probe = run(["-c", "import parselmouth"], AbortSignal.timeout(300_000)).then(
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
    async measure(paths, signal) {
      return JSON.parse(await run([SCRIPT, ffmpeg, ...paths], signal)) as MeasuredVoice;
    },
  };
}
