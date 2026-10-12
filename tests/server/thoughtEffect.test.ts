// The ffmpeg thought effect: what a thought line is given where Pedalboard cannot run. How
// narration chooses it is told in `effectsNarration.test.ts`; this is the filter itself, where this
// machine has an ffmpeg.
import { describe, expect, test } from "bun:test";

import { probeClip } from "~/audio/probe";
import { ffmpegThoughtEffect } from "~/audio/thoughtEffect";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import { ffmpegAvailable } from "~/providers/ffmpegEncoder";
import type { SpeechProvider } from "~/providers/speech";

const ffmpeg = await ffmpegAvailable();

describe.skipIf(!ffmpeg)("ffmpeg's thought effect", () => {
  test("gives back a WAV at the clip's own rate, with its sizes written", async () => {
    const tone = await fakeSpeechProvider().speak({
      text: "I should not have come back here.",
      speaker: "Mara",
      type: "thought",
      encoding: { format: "wav" },
      signal: new AbortController().signal,
    } as Parameters<SpeechProvider["speak"]>[0]);
    const before = await probeClip(tone.bytes, "wav");
    const out = await ffmpegThoughtEffect()(tone.bytes, "wav", new AbortController().signal);
    const after = await probeClip(out, "wav");

    expect(after.sampleRate).toBe(before.sampleRate);
    // the room rings on past the last sample by its longest reflection (160 ms), never much more
    expect(after.duration).toBeGreaterThanOrEqual(before.duration);
    expect(after.duration - before.duration).toBeLessThan(0.2);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(4, true)).toBe(out.byteLength - 8);
    expect(out).not.toEqual(tone.bytes);
  });
});
