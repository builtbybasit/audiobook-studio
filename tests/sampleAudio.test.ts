// What the clone form does to a sample in the browser once it is decoded: find where speech starts
// and ends, cut it there, and write it back out as a WAV. Decoding needs Web Audio, which Bun does
// not have, so these work on samples made here: silence, a tone, and silence around a tone.
import { expect, test } from "bun:test";

import {
  encodeWav,
  SPEECH_PADDING,
  speechBounds,
  trimmedName,
  trimSample,
  type SampleAudio,
} from "@/lib/sampleAudio";

const RATE = 16_000;

/** `seconds` of silence, then of a 220 Hz tone at `amp`, then of silence again. */
function clip(before: number, tone: number, after: number, amp = 0.5): SampleAudio {
  const samples = new Float32Array(Math.round((before + tone + after) * RATE));
  const from = Math.round(before * RATE);
  const to = Math.round((before + tone) * RATE);
  for (let i = from; i < to; i++) samples[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return { samples, sampleRate: RATE, duration: samples.length / RATE };
}

test("a WAV carries a mono 16-bit header and the samples back", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const view = new DataView(encodeWav(samples, RATE));
  const text = (at: number) => String.fromCharCode(...new Uint8Array(view.buffer, at, 4).values());
  expect(view.byteLength).toBe(44 + samples.length * 2);
  expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
  expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(RATE);
  expect(view.getUint32(28, true)).toBe(RATE * 2);
  expect(view.getUint16(32, true)).toBe(2);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(samples.length * 2);
  const back = Array.from(samples, (_, i) => view.getInt16(44 + i * 2, true));
  // Out of range is held at full scale rather than wrapping round.
  expect(back).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
});

test("a clip of silence has no speech", () => {
  expect(speechBounds(clip(2, 0, 0))).toBeNull();
  expect(speechBounds({ samples: new Float32Array(0), sampleRate: RATE, duration: 0 })).toBeNull();
});

test("a near-silent clip has no speech, however its loudest part compares", () => {
  expect(speechBounds(clip(1, 1, 1, 0.003))).toBeNull();
});

test("speech is found around the tone, with room either side", () => {
  const bounds = speechBounds(clip(1, 1, 1))!;
  expect(bounds.start).toBeGreaterThanOrEqual(1 - SPEECH_PADDING - 0.03);
  expect(bounds.start).toBeLessThanOrEqual(1 - SPEECH_PADDING + 0.03);
  expect(bounds.end).toBeGreaterThanOrEqual(2 + SPEECH_PADDING - 0.03);
  expect(bounds.end).toBeLessThanOrEqual(2 + SPEECH_PADDING + 0.03);
});

test("speech at the very edges is held to the clip", () => {
  const audio = clip(0, 1, 0.05);
  expect(speechBounds(audio)).toEqual({ start: 0, end: audio.duration });
});

test("a lone click is not taken for speech", () => {
  const audio = clip(1, 1, 1);
  audio.samples[Math.round(0.2 * RATE)] = 1;
  audio.samples[Math.round(2.8 * RATE)] = -1;
  const bounds = speechBounds(audio)!;
  expect(bounds.start).toBeGreaterThan(0.7);
  expect(bounds.end).toBeLessThan(2.3);
});

test("a trim is the part between start and end, as a WAV named after the original", () => {
  const audio = clip(1, 1, 1);
  const file = trimSample(audio, 0.5, 2.5, "narrator.mp3");
  expect(file.name).toBe("narrator-trimmed.wav");
  expect(file.type).toBe("audio/wav");
  expect(file.size).toBe(44 + 2 * RATE * 2);
});

test("a trim past the clip is held to it", () => {
  const audio = clip(1, 1, 1);
  expect(trimSample(audio, -1, 10, "a.wav").size).toBe(44 + 3 * RATE * 2);
  expect(trimSample(audio, 2, 1, "a.wav").size).toBe(44);
});

test("a trimmed file trimmed again keeps the one -trimmed", () => {
  expect(trimmedName("narrator-trimmed.wav")).toBe("narrator-trimmed.wav");
  expect(trimmedName("voice.take.2.flac")).toBe("voice.take.2-trimmed.wav");
  expect(trimmedName("noext")).toBe("noext-trimmed.wav");
});
