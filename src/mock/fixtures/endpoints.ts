// The TTS servers the prototype starts with. Each endpoint carries its own voice list and a
// per-request character limit (many small TTS servers degrade or truncate past a few hundred
// chars; OpenAI caps at 4096). 0 = no limit.
//
// A factory, not a constant: every call builds a fresh set, voice entries and billing included, so
// a scenario that pauses an endpoint or adds a voice cannot leak into the next world.
import { AZURE_VOICES, KOKORO_VOICES, OPENAI_VOICES } from "./voices";
import type { Endpoint } from "@/types";

export function makeEndpoints(): Endpoint[] {
  return [
    {
      id: "openai",
      name: "OpenAI (main)",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      concurrency: 3,
      enabled: true,
      latency: 1400,
      failRate: 0.01,
      price: 12,
      billing: { unit: "chars", rate: 12 },
      credentialId: "openai-personal",
      quotaGroup: "openai-account",
      spendLimit: 5,
      needsKey: true,
      maxChars: 4096,
      splitAt: "sentence",
      voices: OPENAI_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 30 }, (_, i) => ({
        t: Date.now() - (30 - i) * 60000,
        ms: 1100 + Math.round(Math.sin(i / 3) * 300 + (i % 7) * 60),
        ok: i % 11 !== 4,
      })),
      failures: 2,
      rateLimits: 1,
      backoffUntil: 0,
    },
    {
      id: "local",
      name: "Local Kokoro",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      concurrency: 2,
      enabled: true,
      latency: 2600,
      failRate: 0.025,
      price: 0,
      billing: { unit: "chars", rate: 0 },
      needsKey: false,
      maxChars: 500,
      splitAt: "sentence",
      voices: KOKORO_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 30 }, (_, i) => ({
        t: Date.now() - (30 - i) * 60000,
        ms: 2200 + Math.round(Math.cos(i / 4) * 500 + (i % 5) * 90),
        ok: i % 6 !== 2,
      })),
      failures: 5,
      rateLimits: 0,
      backoffUntil: 0,
    },
    {
      id: "proxy",
      name: "Azure proxy",
      baseUrl: "https://tts-proxy.internal/v1",
      model: "tts-1-hd",
      concurrency: 1,
      enabled: false,
      latency: 1900,
      failRate: 0.05,
      price: 15,
      // billed on the audio it returns, and the rate card was never written down — the page shows
      // this as "unknown", never as free
      billing: { unit: "minute", rate: null },
      credentialId: "proxy-work",
      needsKey: true,
      maxChars: 3000,
      splitAt: "clause",
      voices: AZURE_VOICES.map((v) => ({ ...v })),
      history: [],
      failures: 0,
      rateLimits: 0,
      backoffUntil: 0,
    },
  ];
}
