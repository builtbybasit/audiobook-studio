// A voice-effect runner that runs no Python, for tests about something else. WAV comes back as it
// went in, MP3/Opus as WAV silence of the same length; calls are recorded, and it can be told to
// fail or to report itself unavailable.
import { readFile } from "node:fs/promises";

import type { AudioFormat, Step } from "@/types";
import { formatOfFile } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import type { EffectJob, EffectRunner } from "~/audio/effects";
import { wavHeader } from "~/providers/wav";

export interface FakeEffectRunner extends EffectRunner {
  calls: {
    render: { format: AudioFormat; chains: Step[][] }[];
    batch: EffectJob[][];
    parse: string[];
  };
  /** every call after this is set fails with it; a batch fails each job */
  fail: Error | null;
  /** false: `available()` says no */
  ready: boolean;
}

/** What the fake renders: a WAV as it is, anything else as silence as long as it plays. */
async function rendered(bytes: Uint8Array, format: AudioFormat): Promise<Uint8Array> {
  if (format === "wav") return bytes.slice();
  const { sampleRate, channels, duration } = await probeClip(bytes, format);
  const data = Math.round(duration * sampleRate) * channels * 2;
  const out = new Uint8Array(44 + data);
  out.set(wavHeader({ channels, sampleRate, bits: 16 }, data));
  return out;
}

/** The chain the fake's `parse` reads out of any code. */
export const PARSED: Step[] = [{ plugin: "Gain", params: { gain_db: 0 }, on: true }];

export function fakeEffectRunner(): FakeEffectRunner {
  const fake: FakeEffectRunner = {
    calls: { render: [], batch: [], parse: [] },
    fail: null,
    ready: true,
    available: async () => fake.ready,
    async render(bytes, format, chains) {
      fake.calls.render.push({ format, chains });
      if (fake.fail) throw fake.fail;
      return rendered(bytes, format);
    },
    async batch(jobs, each) {
      fake.calls.batch.push([...jobs]);
      for (const [i, job] of jobs.entries()) {
        if (fake.fail) {
          each(i, fake.fail.message);
          continue;
        }
        try {
          const format = formatOfFile(job.input);
          if (!format) throw new Error(`${job.input} is not a clip`);
          await Bun.write(job.output, await rendered(await readFile(job.input), format));
          each(i, null);
        } catch (e) {
          each(i, (e as Error).message);
        }
      }
    },
    async parse(code) {
      fake.calls.parse.push(code);
      if (fake.fail) throw fake.fail;
      return structuredClone(PARSED);
    },
  };
  return fake;
}
