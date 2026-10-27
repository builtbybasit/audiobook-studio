// Speaker fingerprints from ECAPA under uv, opt-in: `LIVE=1 bun test tests/live`. The first run
// downloads torch (about 1 GB) and the model; hums stand in for voices, so only the shape is checked.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ecapaFingerprinter } from "~/voices/fingerprint";
import { wavHeader } from "~/providers/wav";

/** Two seconds of a tone at `hz` with a few harmonics: 16-bit mono WAV at 24 kHz. */
function hum(hz: number): Uint8Array {
  const rate = 24000;
  const n = 2 * rate;
  const out = new Uint8Array(44 + n * 2);
  out.set(wavHeader({ channels: 1, sampleRate: rate, bits: 16 }, n * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * hz * i) / rate;
    const s = Math.sin(t) + 0.5 * Math.sin(2 * t) + 0.3 * Math.sin(3 * t);
    view.setInt16(44 + i * 2, Math.round(7000 * s), true);
  }
  return out;
}

const dot = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe.skipIf(!process.env.LIVE || !Bun.which("uv"))("ECAPA under uv, for real", () => {
  const dir = mkdtempSync(join(tmpdir(), "fingerprint-"));
  const low = join(dir, "low.wav");
  const high = join(dir, "high.wav");
  writeFileSync(low, hum(110));
  writeFileSync(high, hum(320));
  writeFileSync(join(dir, "junk.wav"), "not a wav");
  const fingerprinter = ecapaFingerprinter();
  const signal = () => AbortSignal.timeout(900_000);

  test("one unit-length vector per path, in order", async () => {
    expect(await fingerprinter.unavailable()).toBeNull();
    const [a, b, again] = await fingerprinter.fingerprint([low, high, low], signal());
    for (const v of [a!, b!, again!]) {
      expect(v).toHaveLength(192);
      expect(dot(v, v)).toBeCloseTo(1, 4);
    }
    expect(again).toEqual(a!);
    expect(dot(a!, b!)).toBeLessThan(0.99);
  }, 900_000);

  test.each([
    ["missing", join(dir, "gone.wav")],
    ["not audio", join(dir, "junk.wav")],
  ])(
    "a %s file is null and the rest of the batch is fingerprinted",
    async (_, path) => {
      const [good, bad] = await fingerprinter.fingerprint([low, path], signal());
      expect(good).toHaveLength(192);
      expect(bad).toBeNull();
    },
    120_000,
  );
});
