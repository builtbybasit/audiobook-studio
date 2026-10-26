// Measuring a voice with Praat under uv (`server/voices/measure.ts`), where this machine has uv:
// two files measured as one, a hum at a known pitch.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parselmouthMeter } from "~/voices/measure";
import { wavHeader } from "~/providers/wav";

const uv = Bun.which("uv");

/** `seconds` of a 180 Hz tone with a few harmonics: 16-bit mono WAV at `rate`. */
function hum(seconds: number, rate: number): Uint8Array {
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(44 + n * 2);
  out.set(wavHeader({ channels: 1, sampleRate: rate, bits: 16 }, n * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * 180 * i) / rate;
    view.setInt16(44 + i * 2, Math.round(8000 * (Math.sin(t) + 0.5 * Math.sin(2 * t))), true);
  }
  return out;
}

describe.skipIf(!uv)("Praat under uv", () => {
  test(
    "files at different rates are joined and measured",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "meter-"));
      const a = join(dir, "a.wav");
      const b = join(dir, "b.wav");
      writeFileSync(a, hum(1.5, 24000));
      writeFileSync(b, hum(1.5, 16000));
      const meter = parselmouthMeter();
      expect(await meter.unavailable()).toBeNull();
      const m = await meter.measure([a, b], new AbortController().signal);
      expect(m.f0).toBeCloseTo(180, -1);
      expect(m.voicedSec).toBeGreaterThan(2.5);
      expect(m.rangeSt).toBeLessThan(1);
    },
    // the first run may download parselmouth
    300_000,
  );
});
