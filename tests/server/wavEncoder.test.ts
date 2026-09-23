// Stitching clips wider than the test voice's.
//
// The fake speech model renders 8-bit mono, where one sample is one byte and any whole number of
// bytes of silence is a whole number of samples. A real model renders 16-bit, often stereo, where
// a sample frame is four bytes — and a pause that is not a multiple of four shifts every sample
// after it out of step, which plays as noise to the end of the file.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWavHeader, silenceBytes, wavEncoder } from "~/providers/wavEncoder";

const STEREO_16 = { channels: 2, sampleRate: 24_000, bits: 16 };
const FRAME = 4;

/** A 16-bit stereo WAV of `frames` frames, every sample a value that says where it came from. */
function clip(frames: number, seed: number): Uint8Array {
  const data = frames * FRAME;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => out.set([c.charCodeAt(0)], at + i));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 24_000 * FRAME, true);
  view.setUint16(32, FRAME, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  for (let i = 0; i < frames * 2; i++) view.setInt16(44 + i * 2, seed * 1000 + (i % 500), true);
  return out;
}

describe("silence in a file of wider samples", () => {
  test("is a whole number of sample frames, however the pause is written", () => {
    // 0.1234 s at 24 kHz is 2961.6 frames: 2962 of them, not the 11,846.4 bytes rounded to 11,846.
    expect(silenceBytes(STEREO_16, 0.1234)).toBe(2962 * FRAME);
    expect(silenceBytes({ channels: 1, sampleRate: 24_000, bits: 16 }, 0.1234)).toBe(2962 * 2);
    expect(silenceBytes({ channels: 1, sampleRate: 8_000, bits: 8 }, 0.5)).toBe(4000);
  });

  test("leaves every clip after it in step, so it plays as the clip it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audiobook-wav-"));
    const paths = [1, 2, 3].map((seed) => {
      const path = join(dir, `c${seed}.wav`);
      writeFileSync(path, clip(1000, seed));
      return path;
    });
    const out = join(dir, "book.wav");
    await wavEncoder().encode({
      chapters: [
        {
          id: 1,
          title: "One",
          parts: [
            { kind: "clip", path: paths[0] },
            // A pause a speech model's timing would produce: not a round number of anything.
            { kind: "silence", seconds: 0.0417 },
            { kind: "clip", path: paths[1] },
          ],
        },
        { id: 2, title: "Two", parts: [{ kind: "clip", path: paths[2] }] },
      ],
      gap: 0.1234,
      out,
      signal: new AbortController().signal,
    });

    const file = new Uint8Array(readFileSync(out));
    const body = readWavHeader(file);
    expect(body.length % FRAME).toBe(0);
    // Each clip's samples are in the file, at a frame boundary, exactly as they were.
    for (const path of paths.slice(1)) {
      const samples = new Uint8Array(readFileSync(path)).slice(44);
      const at = Buffer.from(file).indexOf(Buffer.from(samples));
      expect(at).toBeGreaterThan(body.start);
      expect((at - body.start) % FRAME).toBe(0);
    }
  });
});
