// The real speech provider against the real Fish Audio, opt-in: `LIVE=1 bun test tests/live`
// with `FISHAUDIO_TOKEN` and `FISHAUDIO_VOICE_ID` in `.env`. It spends a handful of short requests
// on the free tier: one test of the key, one sentence at the model's own rate and at 24 kHz, one
// each as MP3 and Opus, and five short lines through the speech gate at the preset's concurrency. Set `LIVE_WAV_DIR` to keep the 24 kHz clip, the MP3 and the Opus for a
// listen.
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { AudioEncoding } from "@/types";
import { AUDIO_EXT } from "@/lib/endpointShapes";
import { probeClip } from "~/audio/probe";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { createSpeechGate } from "~/providers/gate";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { readWavHeader } from "~/providers/wavEncoder";
import { TTS_PRESETS } from "@/lib/presets/speech";

const env = process.env;

describe.skipIf(!env.LIVE || !env.FISHAUDIO_TOKEN)("Fish Audio, for real", () => {
  // the fish-free preset, as the Endpoints page saves it
  const target: ProviderTarget = {
    id: "fish-free",
    name: "Fish Audio (free)",
    baseUrl: "https://api.fish.audio/v1",
    model: "s2.1-pro-free",
    apiKey: env.FISHAUDIO_TOKEN ?? null,
    needsKey: true,
    timeoutSec: 60,
    maxRetries: 1,
    cooldownSec: 8,
  };
  const provider = endpointSpeechProvider();
  const text = "The lamp was lit, and the house was quiet.";
  const line = (
    sampleRate: number | null,
    encoding: AudioEncoding = { format: "wav" },
  ): SpeechInput => ({
    text,
    speaker: "Narrator",
    type: "narration",
    direction: "",
    instructions: "",
    voiceRef: `fish-free/${env.FISHAUDIO_VOICE_ID}`,
    sampleRate,
    encoding,
    target,
    signal: AbortSignal.timeout(90_000),
  });

  test("the key is accepted", async () => {
    const found = await provider.probe!(target, AbortSignal.timeout(30_000));
    expect(found).toMatchObject({ ok: true });
  });

  for (const rate of [null, 24000])
    test(`a sentence comes back as a plain WAV at ${rate ?? "the model's own rate"}`, async () => {
      const clip = await provider.speak(line(rate));
      const head = readWavHeader(clip.bytes);
      expect(head.sampleRate).toBe(rate ?? 44100);
      expect(head.start).toBe(44);
      expect(head.length).toBe(clip.bytes.byteLength - 44);
      // nine words: a couple of seconds, give or take a breath
      expect(clip.duration).toBeGreaterThan(1.2);
      expect(clip.duration).toBeLessThan(8);
      if (rate && env.LIVE_WAV_DIR)
        await Bun.write(join(env.LIVE_WAV_DIR, "fish-live.wav"), clip.bytes);
    }, 120_000);

  // Fish's MP3 is a bare frame stream and its Opus is Ogg; both are kept as they came, their
  // length read from the file rather than taken from a header that is not there
  for (const [encoding, rate] of [
    [{ format: "mp3", bitrate: 64 }, 44100],
    [{ format: "opus" }, 48000],
  ] as const)
    test(`a sentence comes back as ${encoding.format}, kept byte for byte`, async () => {
      const clip = await provider.speak(line(null, encoding));
      expect(clip.format).toBe(encoding.format);
      const info = await probeClip(clip.bytes, encoding.format);
      // no rate asked for: Fish's default for each
      expect(info.sampleRate).toBe(rate);
      expect(info.duration).toBeCloseTo(clip.duration, 6);
      expect(clip.duration).toBeGreaterThan(1.2);
      expect(clip.duration).toBeLessThan(8);
      if (env.LIVE_WAV_DIR)
        await Bun.write(
          join(env.LIVE_WAV_DIR, `fish-live.${AUDIO_EXT[encoding.format]}`),
          clip.bytes,
        );
    }, 120_000);

  // Five lines at once through the gate, at what the fish-free preset allows, as a narration run
  // sends them: every one answers, and any rate limit Fish sends back is told to the gate rather
  // than failing a line.
  test("five lines go out through the gate at the preset's concurrency, and every one answers", async () => {
    const preset = TTS_PRESETS.find((p) => p.id === "fish-free");
    const concurrency = preset?.apply.concurrency ?? 1;
    const gate = createSpeechGate();
    let most = 0;
    let out = 0;
    const clips = await Promise.all(
      ["One.", "Two, then.", "Three of them.", "Four and more.", "Five, at last."].map(
        async (words) => {
          const signal = AbortSignal.timeout(120_000);
          const leave = await gate.acquire(target.id, () => ({ concurrency, enabled: true }), {
            signal,
          });
          most = Math.max(most, ++out);
          try {
            return await provider.speak({
              ...line(null),
              text: words,
              signal,
              rateLimited: (ms) => gate.rateLimited(target.id, ms),
            });
          } finally {
            out--;
            leave();
          }
        },
      ),
    );
    expect(clips).toHaveLength(5);
    for (const clip of clips) expect(clip.duration).toBeGreaterThan(0.2);
    expect(most).toBe(Math.min(5, concurrency));
    console.log(`fish-free at concurrency ${concurrency}:`, gate.live()[target.id]);
  }, 240_000);
});
