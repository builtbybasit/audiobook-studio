// The demo's TTS endpoints. `maxChars` is per request (small TTS servers degrade past a few hundred
// chars; OpenAI caps at 4096); 0 = no limit. A factory so a scenario's changes can't leak.
import {
  AZURE_VOICES,
  FISH_VOICES,
  GEMINI_VOICES,
  KOKORO_VOICES,
  OPENAI_VOICES,
} from "~/demo/seed/fixtures/voices";
import type { Endpoint, ExpressionTag } from "@/types";

/**
 * Fish S2's tags (free-form cues in square brackets). OpenAI documents none; the other endpoints
 * start unconfigured, as a new server does.
 */
export const EXPRESSION_TAGS: ExpressionTag[] = [
  { id: "laughs", label: "Laughs", token: "[laughs]", kind: "sound" },
  { id: "chuckles", label: "Chuckles", token: "[chuckles]", kind: "sound" },
  { id: "sighs", label: "Sighs", token: "[sighs]", kind: "sound" },
  { id: "gasps", label: "Gasps", token: "[gasps]", kind: "sound" },
  { id: "clears throat", label: "Clears throat", token: "[clears throat]", kind: "sound" },
  { id: "pause", label: "Pause", token: "[pause]", kind: "sound" },
  { id: "whispering", label: "Whispering", token: "[whispers]", kind: "delivery" },
  { id: "softly", label: "Softly", token: "[softly]", kind: "delivery" },
  { id: "excited", label: "Excited", token: "[excited]", kind: "delivery" },
  { id: "sad", label: "Sad", token: "[sadly]", kind: "delivery" },
  { id: "angry", label: "Angry", token: "[angrily]", kind: "delivery" },
  { id: "hesitant", label: "Hesitant", token: "[hesitantly]", kind: "delivery" },
];

/**
 * One endpoint per pricing case: openai per 1M characters with off-peak and a promotion; fish per
 * 1M UTF-8 bytes; gemini two rates (text in, audio out); local zero (not unknown); proxy unknown.
 */
export function makeEndpoints(now: number = Date.now()): Endpoint[] {
  const DAY = 24 * 3600e3;
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
      pricing: {
        // not offered for speech
        cachedInput: null,
        cacheWrite: null,
        timezone: "Europe/London",
        windows: [
          {
            id: "tts-off-peak",
            label: "Off-peak",
            days: [],
            from: 22 * 60,
            to: 6 * 60,
            percent: 40,
          },
        ],
        promotions: [
          {
            id: "tts-launch",
            label: "20% off speech",
            from: now - 2 * DAY,
            until: now + 3 * DAY,
            scope: ["model"],
            percent: 20,
            note: "Runs on top of whatever the schedule left — they do not stack.",
          },
        ],
      },
      credentialId: "openai-personal",
      quotaGroup: "openai-account",
      spendLimit: 5,
      needsKey: true,
      maxChars: 4096,
      splitAt: "sentence",
      voices: OPENAI_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 30 }, (_, i) => ({
        t: now - (30 - i) * 60000,
        ms: 1100 + Math.round(Math.sin(i / 3) * 300 + (i % 7) * 60),
        ok: i % 11 !== 4,
      })),
      failures: 2,
      rateLimits: 1,
      backoffUntil: 0,
    },
    {
      // Fish meters UTF-8 bytes, not characters; the demo routes a Mandarin speaker here.
      id: "fish",
      name: "Fish Audio",
      baseUrl: "https://api.fish.audio/v1",
      model: "s2.1-pro",
      concurrency: 4,
      enabled: true,
      latency: 1100,
      failRate: 0.02,
      price: 0,
      billing: { unit: "bytes", rate: 15 },
      pricing: {
        cachedInput: null,
        cacheWrite: null,
        timezone: "Europe/London",
        windows: [],
        promotions: [
          {
            id: "fish-launch",
            label: "25% off bytes",
            from: now - 1 * DAY,
            until: now + 5 * DAY,
            scope: ["speech"],
            percent: 25,
            note: "A promotion scoped to the speech rate discounts whichever quantity this endpoint bills on.",
          },
        ],
      },
      credentialId: "fish-personal",
      needsKey: true,
      maxChars: 0,
      splitAt: "sentence",
      expressions: {
        status: "supported",
        model: "s2.1-pro",
        baseUrl: "https://api.fish.audio/v1",
        brackets: ["square"],
        open: true,
        tags: EXPRESSION_TAGS.map((t) => ({ ...t })),
      },
      voices: FISH_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 20 }, (_, i) => ({
        t: now - (20 - i) * 60000,
        ms: 1000 + Math.round(Math.sin(i / 2) * 200 + (i % 4) * 70),
        ok: i % 9 !== 3,
      })),
      failures: 1,
      rateLimits: 0,
      backoffUntil: 0,
    },
    {
      // Two rates. Audio tokens follow the recording's length, so an estimate assumes
      // `audioTokensPerSecond`, an editable guess at the provider's tokeniser.
      id: "gemini",
      name: "Gemini 3.1 Flash TTS",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.1-flash-tts-preview",
      concurrency: 2,
      enabled: true,
      latency: 1800,
      failRate: 0.015,
      price: 0,
      billing: {
        unit: "audio-tokens",
        rate: 1,
        audioRate: 20,
        audioTokensPerSecond: 25,
      },
      pricing: {
        cachedInput: null,
        cacheWrite: null,
        timezone: "Europe/London",
        windows: [],
        promotions: [
          {
            id: "gemini-preview",
            label: "Preview: half price audio",
            from: now - 3 * DAY,
            until: now + 10 * DAY,
            // audio half only, to exercise a per-component scope
            scope: ["audioTokens"],
            percent: 50,
            note: "Applies to the output audio tokens only. The input text rate is unchanged.",
          },
        ],
      },
      credentialId: null,
      needsKey: true,
      maxChars: 5000,
      splitAt: "sentence",
      voices: GEMINI_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 24 }, (_, i) => ({
        t: now - (24 - i) * 60000,
        ms: 1700 + Math.round(Math.cos(i / 3) * 400 + (i % 6) * 55),
        ok: i % 12 !== 7,
      })),
      failures: 2,
      rateLimits: 0,
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
      // zero, not `null`: shown as "free", not "unknown"
      billing: { unit: "chars", rate: 0 },
      needsKey: false,
      maxChars: 500,
      splitAt: "sentence",
      voices: KOKORO_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 30 }, (_, i) => ({
        t: now - (30 - i) * 60000,
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
      // rate never entered: shown as "unknown", never as free
      billing: { unit: "minute", rate: null },
      pricing: {
        cachedInput: null,
        cacheWrite: null,
        timezone: "Europe/London",
        windows: [
          {
            id: "proxy-night",
            label: "Night rate",
            days: [],
            from: 20 * 60,
            to: 7 * 60,
            percent: 30,
          },
        ],
        // a discount on an unknown rate stays unknown
        promotions: [],
      },
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
