// The real speech provider against the real Fish Audio, opt-in: `LIVE=1 bun test tests/live`
// with `FISHAUDIO_TOKEN` and `FISHAUDIO_VOICE_ID` in `.env`. It spends a handful of short requests
// on the free tier: one test of the key, and one sentence at the model's own rate and at 24 kHz.
// Set `LIVE_WAV_DIR` to keep the 24 kHz clip for a listen.
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { readWavHeader } from "~/providers/wavEncoder";

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
  const line = (sampleRate: number | null): SpeechInput => ({
    text,
    speaker: "Narrator",
    type: "narration",
    direction: "",
    instructions: "",
    voiceRef: `fish-free/${env.FISHAUDIO_VOICE_ID}`,
    sampleRate,
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
});
