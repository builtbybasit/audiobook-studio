// Voice effects run on clips: the Pedalboard chains a line is given (`src/lib/effects.ts`) applied
// to its audio, by `effects.py` under uv. A port, like the encoder: Pedalboard where this machine
// has uv, today's ffmpeg thought effect (`thoughtEffect.ts`) where it does not, and a fake in tests
// (`tests/support/effects.ts`).
//
// uv is asked for an exact Pedalboard, so the first run downloads it once and every run after that
// starts from uv's cache, offline, the same plugins making the same sound.
//
// Each call is its own Python process: a preview or a landing clip pays uv's start-up (a tenth of
// a second or so) and nothing stays running between them. A Re-apply of a whole book is one
// `batch`, spread over a process per core, each taking its share of the clips as NDJSON and
// answering a line per clip as it finishes.
//
// What comes out is always a 16-bit WAV at the clip's own rate, for the reasons the thought effect
// gives; an MP3 or an Opus clip is decoded by ffmpeg inside `effects.py` before it is processed.
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";

import type { AudioFormat, Step } from "@/types";

export const SCRIPT = fileURLToPath(new URL("./effects.py", import.meta.url));
export const PEDALBOARD = "pedalboard==0.9.26";

export interface EffectJob {
  /** the clip's file; its extension says its format */
  input: string;
  /** where the processed WAV is written */
  output: string;
  chains: Step[][];
}

export interface EffectRunner {
  /** Whether chains can run here (uv, and Pedalboard through it); asked once, then remembered. */
  available(): Promise<boolean>;
  /** A clip through these chains in order, as 16-bit WAV bytes. Throws when it cannot. */
  render(
    bytes: Uint8Array,
    format: AudioFormat,
    chains: Step[][],
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  /**
   * Files through their chains, spread over the runner's workers. `each` hears every job by its
   * index as it ends, with null or why it failed; one failing never stops the rest. A cancel
   * kills every worker and throws.
   */
  batch(
    jobs: readonly EffectJob[],
    each: (i: number, error: string | null) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Pasted Pedalboard Python as a chain; throws with the parser's one-line reason. */
  parse(code: string, signal: AbortSignal): Promise<Step[]>;
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim() ?? "";

/** A child that a cancel kills. */
function start(cmd: string[], stdin: Uint8Array, signal: AbortSignal) {
  const proc = Bun.spawn(cmd, { stdin, stdout: "pipe", stderr: "pipe" });
  const kill = (): void => proc.kill();
  if (signal.aborted) kill();
  signal.addEventListener("abort", kill, { once: true });
  void proc.exited.finally(() => signal.removeEventListener("abort", kill));
  return proc;
}

/** Job indexes dealt round to `workers` lanes, so long and short chapters spread evenly. */
export function lanes(count: number, workers: number): number[][] {
  const out: number[][] = Array.from({ length: Math.min(count, Math.max(1, workers)) }, () => []);
  for (let i = 0; i < count; i++) out[i % out.length].push(i);
  return out;
}

export function pedalboardRunner(
  opts: { uv?: string; ffmpeg?: string; workers?: number } = {},
): EffectRunner {
  const { uv = "uv", ffmpeg = "ffmpeg", workers = cpus().length } = opts;
  const python = (...args: string[]): string[] => [
    uv,
    "run",
    "-q",
    "--no-project",
    "--with",
    PEDALBOARD,
    "python",
    "-I",
    ...args,
  ];
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  /** One run to its end: stdout, or a throw with the script's last words. */
  const run = async (args: string[], stdin: Uint8Array, signal: AbortSignal) => {
    const proc = start(python(...args), stdin, signal);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal.aborted) throw signal.reason;
    if (code !== 0) throw new Error(lastLine(err) || `effects.py exited with ${code}`);
    return out;
  };

  let ready: Promise<boolean> | undefined;

  return {
    available: () =>
      (ready ??= run(["-c", "import pedalboard"], new Uint8Array(), AbortSignal.timeout(300_000))
        .then(() => true)
        .catch(() => false)),

    async render(bytes, format, chains, signal) {
      const head = encode(`${JSON.stringify({ format, chains })}\n`);
      const stdin = new Uint8Array(head.length + bytes.length);
      stdin.set(head);
      stdin.set(bytes, head.length);
      return run([SCRIPT, "render", ffmpeg], stdin, signal);
    },

    async parse(code, signal) {
      return JSON.parse(
        new TextDecoder().decode(await run([SCRIPT, "parse"], encode(code), signal)),
      );
    },

    async batch(jobs, each, signal) {
      await Promise.all(
        lanes(jobs.length, workers).map(async (lane) => {
          const ndjson = lane.map((i) => JSON.stringify(jobs[i])).join("\n");
          let proc;
          try {
            proc = start(python(SCRIPT, "batch", ffmpeg), encode(`${ndjson}\n`), signal);
          } catch (e) {
            for (const i of lane) each(i, (e as Error).message);
            return;
          }
          const stderr = new Response(proc.stderr).text();
          const heard = new Set<number>();
          let rest = "";
          for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
            const lines = (rest + chunk).split("\n");
            rest = lines.pop()!;
            for (const line of lines) {
              const r = JSON.parse(line) as { i: number; error?: string };
              heard.add(r.i);
              each(lane[r.i], r.error ?? null);
            }
          }
          const code = await proc.exited;
          if (signal.aborted) return;
          // a worker that died (no uv, Python crashed) answers for the clips it never reached
          const why = lastLine(await stderr) || `effects.py exited with ${code}`;
          lane.forEach((i, at) => heard.has(at) || each(i, why));
        }),
      );
      if (signal.aborted) throw signal.reason;
    },
  };
}
