// The voice-effect runner: how a book's clips are dealt to workers, what a render and a batch hand
// the Python side and how its answers come back — told with a stand-in for uv, a shell script —
// and then the real thing, Pedalboard under uv, where this machine has uv.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Step } from "@/types";
import { lanes, PEDALBOARD, pedalboardRunner, SCRIPT } from "~/audio/effects";
import { probeClip } from "~/audio/probe";
import { ffmpegAvailable } from "~/providers/ffmpegEncoder";
import { readWavHeader, wavHeader } from "~/providers/wav";
import { fakeEffectRunner } from "../support/effects";
import { oggOpus } from "../support/encoded";

const live = () => new AbortController().signal;

/** A stand-in for uv: a shell script given the body of what it does with stdin. */
function standIn(body: string): { uv: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "effects-"));
  const uv = join(dir, "uv");
  writeFileSync(uv, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n${body}\n`);
  chmodSync(uv, 0o755);
  return { uv, dir };
}

/** `seconds` of a 440 Hz sine at half scale: 16-bit mono WAV at 24 kHz. */
function sine(seconds: number, rate = 24000): Uint8Array {
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(44 + n * 2);
  out.set(wavHeader({ channels: 1, sampleRate: rate, bits: 16 }, n * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++)
    view.setInt16(44 + i * 2, Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / rate)), true);
  return out;
}

/** The loudest sample in a 16-bit WAV between two times, as a fraction of full scale. */
function peak(wav: Uint8Array, from: number, to = Infinity): number {
  const { start, length, sampleRate } = readWavHeader(wav);
  const view = new DataView(wav.buffer, wav.byteOffset + start, length);
  let max = 0;
  const end = Math.min(length / 2, Math.round(to * sampleRate));
  for (let i = Math.round(from * sampleRate); i < end; i++)
    max = Math.max(max, Math.abs(view.getInt16(i * 2, true)));
  return max / 32768;
}

const GAIN: Step = { plugin: "Gain", params: { gain_db: -6 }, on: true };
const ROOM: Step = { plugin: "Reverb", params: { room_size: 0.9, wet_level: 0.5 }, on: true };

describe("lanes", () => {
  test("deal jobs round, one lane per worker and never an empty one", () => {
    expect(lanes(5, 2)).toEqual([
      [0, 2, 4],
      [1, 3],
    ]);
    expect(lanes(2, 8)).toEqual([[0], [1]]);
    expect(lanes(3, 0)).toEqual([[0, 1, 2]]);
    expect(lanes(0, 4)).toEqual([]);
  });
});

describe("what the runner hands effects.py", () => {
  test("a render is one JSON line with the format and chains, then the clip", async () => {
    const { uv, dir } = standIn("cat");
    const clip = new Uint8Array([1, 2, 3, 0, 10]);
    const out = await pedalboardRunner({ uv, ffmpeg: "/x/ffmpeg" }).render(
      clip,
      "opus",
      [[GAIN], [ROOM]],
      live(),
    );
    const nl = out.indexOf(10);
    expect(JSON.parse(new TextDecoder().decode(out.slice(0, nl)))).toEqual({
      format: "opus",
      chains: [[GAIN], [ROOM]],
    });
    expect(out.slice(nl + 1)).toEqual(clip);
    const args = readFileSync(join(dir, "args"), "utf8").trim().split("\n");
    expect(args.slice(0, 7)).toEqual([
      "run",
      "-q",
      "--no-project",
      "--with",
      args[4],
      "python",
      "-I",
    ]);
    expect(args.slice(-2)).toEqual(["render", "/x/ffmpeg"]);
  });

  test("a batch answers for every job by its own index, a dead worker for the ones it never reached", async () => {
    const { uv } = standIn(`i=0
while IFS= read -r line; do
  case "$line" in
    *die*) echo "it fell over" >&2; exit 1;;
    *bad*) echo "{\\"i\\":$i,\\"error\\":\\"bad clip\\"}";;
    *) echo "{\\"i\\":$i,\\"ok\\":true}";;
  esac
  i=$((i+1))
done`);
    // lane 0 holds 0, 2, 4 and dies at 2; lane 1 holds 1, 3 and fails 3
    const jobs = ["a", "b", "die", "bad", "c"].map((name) => ({
      input: `${name}.wav`,
      output: `${name}.out.wav`,
      chains: [[GAIN]],
    }));
    const heard = new Map<number, string | null>();
    await pedalboardRunner({ uv, workers: 2 }).batch(jobs, (i, e) => heard.set(i, e), live());
    expect([...heard.entries()].sort(([a], [b]) => a - b)).toEqual([
      [0, null],
      [1, null],
      [2, "it fell over"],
      [3, "bad clip"],
      [4, "it fell over"],
    ]);
  });

  test("a cancel kills the worker and throws", async () => {
    const { uv } = standIn("sleep 30");
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(new Error("cancelled")), 50);
    const runner = pedalboardRunner({ uv, workers: 2 });
    await expect(runner.render(sine(0.1), "wav", [], ac.signal)).rejects.toThrow("cancelled");
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(new Error("cancelled")), 50);
    const jobs = [1, 2, 3].map((n) => ({ input: `${n}.wav`, output: `${n}.o.wav`, chains: [] }));
    await expect(runner.batch(jobs, () => {}, ac2.signal)).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("with no uv it is not available, and a render says why", async () => {
    const runner = pedalboardRunner({ uv: "/no/such/uv" });
    expect(await runner.available()).toBe(false);
    await expect(runner.render(sine(0.1), "wav", [], live())).rejects.toThrow();
    const heard: (string | null)[] = [];
    await runner.batch(
      [{ input: "a.wav", output: "b.wav", chains: [] }],
      (_i, e) => heard.push(e),
      live(),
    );
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeString();
  });
});

const uv = Bun.which("uv");
const ffmpeg = await ffmpegAvailable();
// the first run may download Pedalboard
const FIRST = 300_000;

describe.skipIf(!uv)("Pedalboard under uv", () => {
  const runner = pedalboardRunner({ workers: 2 });

  test(
    "is available",
    async () => {
      expect(await runner.available()).toBe(true);
    },
    FIRST,
  );

  test("a room rings on past the clip, and a dry chain is trimmed back to it", async () => {
    const clip = sine(0.5);
    const wet = await runner.render(clip, "wav", [[GAIN], [ROOM]], live());
    const info = await probeClip(wet, "wav");
    expect(info.sampleRate).toBe(24000);
    expect(readWavHeader(wet).bits).toBe(16);
    expect(info.duration).toBeGreaterThan(0.5);
    expect(info.duration).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(peak(wet, 0.55)).toBeGreaterThan(0.001);

    const dry = await runner.render(clip, "wav", [[GAIN]], live());
    expect((await probeClip(dry, "wav")).duration).toBeCloseTo(0.5, 6);
    expect(peak(dry, 0)).toBeCloseTo(peak(clip, 0) / 2, 2);
  });

  test("a room still ringing where the pad ends is faded out, not cut", async () => {
    const wet = await runner.render(sine(0.5), "wav", [[ROOM]], live());
    const { duration } = await probeClip(wet, "wav");
    // the room outlasts the pad, so the clip runs to its end …
    expect(duration).toBeCloseTo(0.9, 3);
    expect(peak(wet, duration - 0.06, duration - 0.03)).toBeGreaterThan(0.001);
    // … and its last samples come down to nothing rather than stopping on a step
    expect(peak(wet, duration - 0.0005)).toBeLessThan(0.001);
  });

  test("an off step is skipped", async () => {
    const clip = sine(0.2);
    const out = await runner.render(clip, "wav", [[{ ...GAIN, on: false }]], live());
    expect(peak(out, 0)).toBeCloseTo(peak(clip, 0), 3);
  });

  test("the plugins are read from Pedalboard: the number-only ones, never a file loader", async () => {
    const read = `import json, sys; sys.path.insert(0, ${JSON.stringify(dirname(SCRIPT))})
import effects; print(json.dumps(effects.plugins()))`;
    const proc = Bun.spawn([
      "uv",
      "run",
      "-q",
      "--no-project",
      "--with",
      PEDALBOARD,
      "python",
      "-I",
      "-c",
      read,
    ]);
    const table = (await new Response(proc.stdout).json()) as Record<
      string,
      [string[], number, string[]]
    >;
    const numbers = (name: string) => table[name]?.[0];
    expect(numbers("Gain")).toEqual(["gain_db"]);
    expect(numbers("Compressor")).toEqual(["threshold_db", "ratio", "attack_ms", "release_ms"]);
    expect(numbers("Limiter")).toEqual(["threshold_db", "release_ms"]);
    expect(numbers("NoiseGate")).toEqual(["threshold_db", "ratio", "attack_ms", "release_ms"]);
    for (const f of ["HighpassFilter", "LowpassFilter"])
      expect(numbers(f)).toEqual(["cutoff_frequency_hz"]);
    for (const f of ["HighShelfFilter", "LowShelfFilter", "PeakFilter"])
      expect(numbers(f)).toEqual(["cutoff_frequency_hz", "gain_db", "q"]);
    expect(numbers("Delay")).toEqual(["delay_seconds", "feedback", "mix"]);
    expect(numbers("Reverb")).toEqual([
      "room_size",
      "damping",
      "wet_level",
      "dry_level",
      "width",
      "freeze_mode",
    ]);
    expect(numbers("Chorus")).toEqual(["rate_hz", "depth", "centre_delay_ms", "feedback", "mix"]);
    expect(numbers("Phaser")).toEqual([
      "rate_hz",
      "depth",
      "centre_frequency_hz",
      "feedback",
      "mix",
    ]);
    expect(numbers("Distortion")).toEqual(["drive_db"]);
    expect(numbers("Bitcrush")).toEqual(["bit_depth"]);
    expect(numbers("Clipping")).toEqual(["threshold_db"]);
    expect(numbers("PitchShift")).toEqual(["semitones"]);
    expect(table.Resample).toEqual([["target_sample_rate"], 1, ["quality"]]);
    expect(numbers("MP3Compressor")).toEqual(["vbr_quality"]);
    expect(numbers("Invert")).toEqual([]);
    expect(table.BrickwallLimiter).toEqual([
      ["ceiling_db", "release_ms", "lookahead_ms"],
      3,
      ["true_peak"],
    ]);
    expect(table.LadderFilter).toEqual([["cutoff_hz", "resonance", "drive"], 0, ["mode"]]);
    expect(table.GSMFullRateCompressor).toEqual([[], 0, ["quality"]]);
    for (const never of ["Convolution", "VST3Plugin", "AudioUnitPlugin", "Pedalboard", "Mix"])
      expect(table[never]).toBeUndefined();
  });

  test("the new plugins render, a ladder filter's cutoff by name", async () => {
    const clip = sine(0.3);
    const out = await runner.render(
      clip,
      "wav",
      [
        [
          { plugin: "BrickwallLimiter", params: { ceiling_db: -12 }, on: true },
          { plugin: "LadderFilter", params: { cutoff_hz: 800, resonance: 0.2 }, on: true },
        ],
      ],
      live(),
    );
    expect((await probeClip(out, "wav")).duration).toBeGreaterThanOrEqual(0.3);
    expect(peak(out, 0.05)).toBeLessThan(peak(clip, 0.05));
    const mode = [{ plugin: "LadderFilter", params: { mode: 1 }, on: true }];
    await expect(runner.render(clip, "wav", [mode], live())).rejects.toThrow(
      "LadderFilter's mode can't be set here; it keeps its default",
    );
  });

  test("a plugin it does not know is refused", async () => {
    const chain = [{ plugin: "Popen", params: {}, on: true }];
    await expect(runner.render(sine(0.1), "wav", [chain], live())).rejects.toThrow(
      "Popen is not a plugin this editor knows",
    );
  });

  test.skipIf(!ffmpeg)("an Opus clip is decoded first, and comes back at its 48 kHz", async () => {
    const out = await runner.render(oggOpus(25), "opus", [[ROOM]], live());
    const info = await probeClip(out, "wav");
    expect(info.sampleRate).toBe(48000);
    expect(info.duration).toBeGreaterThanOrEqual(0.49);
  });

  test("a batch writes each clip, and one it cannot read costs only itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "effects-batch-"));
    writeFileSync(join(dir, "a.wav"), sine(0.3));
    writeFileSync(join(dir, "b.wav"), sine(0.4));
    const jobs = ["a", "missing", "b"].map((name) => ({
      input: join(dir, `${name}.wav`),
      output: join(dir, `${name}.out.wav`),
      chains: [[GAIN, ROOM]],
    }));
    const heard = new Map<number, string | null>();
    await runner.batch(jobs, (i, e) => heard.set(i, e), live());
    expect(heard.get(0)).toBeNull();
    expect(heard.get(2)).toBeNull();
    expect(heard.get(1)).toBeString();
    expect(existsSync(jobs[1].output)).toBe(false);
    const b = await probeClip(readFileSync(jobs[2].output), "wav");
    expect(b.duration).toBeGreaterThan(0.4);
  });

  test("parse reads Pedalboard code, Mix and values in order included", async () => {
    const code = `from pedalboard import Pedalboard, Mix, Gain, Reverb, HighpassFilter
board = Pedalboard([
    HighpassFilter(170),
    Mix([Pedalboard([Gain(-3)]), [Reverb(0.2, wet_level=0.3)]]),
])
out = board(audio, sample_rate)
`;
    expect(await runner.parse(code, live())).toEqual([
      { plugin: "HighpassFilter", params: { cutoff_frequency_hz: 170 }, on: true },
      {
        mix: [
          { name: "A", steps: [{ plugin: "Gain", params: { gain_db: -3 }, on: true }], on: true },
          {
            name: "B",
            steps: [{ plugin: "Reverb", params: { room_size: 0.2, wet_level: 0.3 }, on: true }],
            on: true,
          },
        ],
        on: true,
      },
    ]);
  });

  test("parse never runs what it is given, and names the line it stopped at", async () => {
    await expect(runner.parse("x = 1\n__import__('os').system('true')", live())).rejects.toThrow(
      /^line 2: system is not a plugin/,
    );
    await expect(runner.parse("Pedalboard([Fuzz(3)])", live())).rejects.toThrow(
      "line 1: Fuzz is not a plugin this editor knows",
    );
    await expect(runner.parse("Pedalboard([Gain(", live())).rejects.toThrow(/^line 1: /);
  });
});

describe("the fake runner", () => {
  test("gives a WAV back as it came, an Opus clip as silence as long, and fails when told", async () => {
    const fake = fakeEffectRunner();
    const clip = sine(0.2);
    expect(await fake.render(clip, "wav", [[GAIN]], live())).toEqual(clip);
    const opus = await probeClip(await fake.render(oggOpus(25), "opus", [], live()), "wav");
    expect(opus.sampleRate).toBe(48000);
    expect(opus.duration).toBeCloseTo((await probeClip(oggOpus(25), "opus")).duration, 3);
    fake.fail = new Error("no uv");
    await expect(fake.parse("Gain()", live())).rejects.toThrow("no uv");
    expect(fake.calls.render).toHaveLength(2);
  });
});
