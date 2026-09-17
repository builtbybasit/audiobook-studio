// The TTS servers the prototype starts with. Each endpoint carries its own voice list and a
// per-request character limit (many small TTS servers degrade or truncate past a few hundred
// chars; OpenAI caps at 4096). 0 = no limit.
//
// A factory, not a constant: every call builds a fresh set, voice entries and billing included, so
// a scenario that pauses an endpoint or adds a voice cannot leak into the next world.
import {
  AZURE_VOICES,
  FISH_VOICES,
  GEMINI_VOICES,
  KOKORO_VOICES,
  OPENAI_VOICES,
} from "@/mock/fixtures/voices";
import type { Endpoint, ExpressionTag } from "@/types";

/**
 * The expression tags the main OpenAI model is configured with, so a line read by it can carry
 * a vocal sound or a delivery note out of the box. Tags are per model: the other endpoints start
 * unconfigured, which is the state a new server is really in.
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
 * The speech endpoints' rate cards.
 *
 * A speech rate goes on discount exactly the way a token rate does — the schedule, the promotions
 * and the precedence are the same code — and the seeded world carries one endpoint of every case
 * the pricing has to get right, so all of it can be inspected without configuring anything:
 *
 *   openai   per 1M **characters**, inside a nightly off-peak window with a promotion on top
 *   fish     per 1M **UTF-8 bytes** — the case where the character count is not the bill
 *   gemini   **two rates**: input text tokens and output audio tokens, priced separately
 *   local    a model you host yourself: **zero**, which is not the same as unknown
 *   proxy    a rate **nobody typed in**: unknown, and a discount on it is still unknown
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
        // cached input means nothing for speech and is never offered on this tab
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
      expressions: {
        status: "supported",
        model: "gpt-4o-mini-tts",
        baseUrl: "https://api.openai.com/v1",
        tags: EXPRESSION_TAGS.map((t) => ({ ...t })),
      },
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
      // Byte billing. Fish Audio's price list talks about characters and its API meters UTF-8
      // bytes, which are the same number only while the text is ASCII — so this endpoint is the
      // one the demo routes a Mandarin speaker through, where the bill is three times the
      // character count and the Activity list shows both figures side by side.
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
      voices: FISH_VOICES.map((v) => ({ ...v })),
      history: Array.from({ length: 20 }, (_, i) => ({
        t: Date.now() - (20 - i) * 60000,
        ms: 1000 + Math.round(Math.sin(i / 2) * 200 + (i % 4) * 70),
        ok: i % 9 !== 3,
      })),
      failures: 1,
      rateLimits: 0,
      backoffUntil: 0,
    },
    {
      // Two rates on two different quantities. The input half is counted from the text that will
      // actually be submitted; the audio half cannot be — it follows the length of the recording,
      // so an estimate goes through `audioTokensPerSecond`, which is an assumption about the
      // provider's tokeniser and is therefore editable rather than buried in the arithmetic.
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
            // Scoped to one half on purpose: the audio side is what a TTS bill is made of, and a
            // discount that only touches it is the case a per-component scope exists for.
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
        t: Date.now() - (24 - i) * 60000,
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
      // Zero, and deliberately not `null`: a model you host yourself really does cost nothing, and
      // the page says "free" rather than "unknown". Nothing to schedule, nothing to promote.
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
        // A discount on a rate nobody knows is still a rate nobody knows. This window is in force
        // half the day and the effective price stays "unknown" rather than becoming a confident
        // number — which is the case the page has to survive, not a case it has to hide.
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
