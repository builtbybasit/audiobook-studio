// The speech presets: what "Start from a preset…" offers a text-to-speech endpoint, grouped by
// provider. Each rate is the provider's published card on the date its note gives. Each
// `concurrency` comes from the provider's own docs as read on 2026-09-28, for the lowest plan or
// tier someone using the preset plausibly has; a larger plan can raise it on the Requests tab.
// Where a provider documents only a request rate, or none, the comment beside it says why.
import type { ExpressionTag } from "@/types";
import { presetPricing, type TtsPreset } from "@/lib/presets/preset";
import { SIMULATED_BASE_URL, SIMULATED_SPEECH_MODEL, SIMULATED_VOICES } from "@/lib/providers";

/**
 * OpenAI's first two speech models, still offered: billed per character of input, so a line's cost
 * is exact rather than estimated, at up to 4,096 characters a request. They take no instructions,
 * and speak 9 of the 13 voices `gpt-4o-mini-tts` does.
 */
function openaiTts1(model: string, label: string, hint: string, rate: number): TtsPreset {
  return {
    id: `openai-${model}`,
    group: "OpenAI",
    label,
    hint,
    note:
      `$${rate} per million characters, each one counted, so a line's price is exact. It speaks ` +
      "alloy, ash, coral, echo, fable, onyx, nova, sage and shimmer — not ballad, verse, marin or " +
      "cedar, which Fetch also lists — and ignores a line's direction. " +
      "Rates as published on 28 September 2026.",
    apply: {
      name: label,
      baseUrl: "https://api.openai.com/v1",
      model,
      needsKey: true,
      price: rate,
      billing: { unit: "chars", rate },
      maxChars: 4096,
      splitAt: "sentence",
      // no documented concurrency; Tier 1 is 500 RPM for both models, and 8 lines at once stay
      // under it while each takes a second or more
      // (https://developers.openai.com/api/docs/models/tts-1)
      concurrency: 8,
      latency: 1400,
      failRate: 0.01,
    },
  };
}

/**
 * An ElevenLabs model: billed per character of the text, at `rate` dollars per million — ElevenLabs
 * prices per thousand — and up to `maxChars` a request, the model's own limit.
 */
function elevenLabs(
  model: string,
  label: string,
  hint: string,
  rate: number,
  maxChars: number,
): TtsPreset {
  return {
    id: `elevenlabs-${model}`,
    group: "ElevenLabs",
    label,
    hint,
    note:
      `$${rate / 1000} per thousand characters, up to ${maxChars.toLocaleString("en")} a request. ` +
      "A voice is a voice_id from your ElevenLabs account; Fetch lists them. ElevenLabs says " +
      "44.1 kHz PCM needs a Pro plan and 192 kbps MP3 a Creator plan; it names no plan for " +
      "other rates. " +
      (model === "eleven_v3"
        ? "Delivery goes in the text as audio tags such as [whispers] or [laughs], set up on the " +
          "Expressions tab. "
        : "") +
      "Rates as published on 28 September 2026.",
    apply: {
      name: label,
      baseUrl: "https://api.elevenlabs.io/v1",
      model,
      needsKey: true,
      price: rate,
      billing: { unit: "chars", rate },
      maxChars,
      splitAt: "sentence",
      // the Starter plan's limit: 6 for Flash and Turbo models, 3 for every other
      // (https://elevenlabs.io/docs/help-center/technical/how-many-text-to-speech-requests-can-i-make-and-can-i-increase-it)
      concurrency: /^eleven_(flash|turbo)_/.test(model) ? 6 : 3,
      latency: 1500,
      failRate: 0.01,
    },
  };
}

const RATES_AS_OF = "Rates as published on 28 September 2026.";

/**
 * A BreezeBlue model through its hosted API, shaped like ElevenLabs'. Billed per character of the
 * request text alone — a Chinese, Japanese or Korean one counts twice, and the instructions beside
 * it are free — at $40 a million on the free plan and less on paid ones, up to 1,000 characters a
 * request unless BreezeBlue raises it.
 */
function breezeTts(model: string, label: string, hint: string, languages: string): TtsPreset {
  return {
    id: model,
    group: "BreezeBlue",
    label,
    hint,
    note:
      `${languages} $40 per million characters on the free plan — $36, $32 and $28 on Starter, ` +
      "Creator and Pro — with a Chinese, Japanese or Korean character counting as two; set the " +
      "rate to your plan's. Only the text is billed, not the instructions beside it. Up to 1,000 " +
      "characters a request. A line's style and direction go as its instructions; sound tags " +
      "such as (laughs) or (pause) go in the text, from the " +
      "Expressions tab. Commercial use needs a paid plan. " +
      RATES_AS_OF,
    apply: {
      name: label,
      baseUrl: "https://api.breeze.blue/v1",
      model,
      needsKey: true,
      price: 40,
      billing: { unit: "chars", rate: 40, billsInstructions: false },
      maxChars: 1000,
      splitAt: "sentence",
      // the free plan's concurrent generations, shared with Studio; Starter allows 6
      // (https://docs.breezeblue.ai/reference/rate-limits)
      concurrency: 3,
      latency: 1500,
      failRate: 0.01,
    },
  };
}

/**
 * A MiniMax speech model: billed per character at `rate` dollars a million. MiniMax takes under
 * 10,000 characters a request, but recommends streaming above 3,000, and its answer is the audio
 * as hex inside one JSON body — about 80 MB for a 10,000-character line — so requests are kept to
 * 3,000.
 */
function miniMax(model: string, label: string, hint: string, rate: number): TtsPreset {
  return {
    id: `minimax-${model}`,
    group: "MiniMax",
    label,
    hint,
    note:
      `$${rate} per million characters. Requests are kept to 3,000 characters: MiniMax takes up ` +
      "to 9,999 but recommends streaming above 3,000, and a longer answer is tens of megabytes " +
      "of hex. MiniMax reports the characters it billed, which the ledger keeps. A voice is a voice_id such as English_expressive_narrator; " +
      "Fetch lists the system voices and any you cloned or designed. Pauses go in the text as " +
      "<#0.5#> and sounds as (laughs) or (sighs), from the Expressions tab. " +
      RATES_AS_OF,
    apply: {
      name: label,
      baseUrl: "https://api.minimax.io/v1",
      model,
      needsKey: true,
      price: rate,
      billing: { unit: "chars", rate },
      maxChars: 3000,
      splitAt: "sentence",
      // no documented concurrency; T2A is 60 RPM, which one line at a time already reaches when a
      // line takes a second (https://platform.minimax.io/docs/guides/rate-limits)
      concurrency: 1,
      latency: 1500,
      failRate: 0.01,
    },
  };
}

/**
 * A Qwen-Audio 3.0 model through Alibaba's Model Studio, Singapore region: billed per 10,000
 * characters — a Chinese one counting twice — with the audio itself free.
 */
function qwenTts(model: string, label: string, hint: string, rate: number): TtsPreset {
  return {
    id: model,
    group: "Alibaba Qwen",
    label,
    hint,
    note:
      `$${(rate / 100).toFixed(2)} per 10,000 characters, a Chinese character counting as two; the first ` +
      "10,000 are free for 90 days. Each model has its own voices — Fetch lists this one's system " +
      "voices, and its 500 base voices can be added by id. WAV at 24 kHz. Requests are kept to 600 " +
      "characters: Alibaba publishes no limit for these models, and 600 is the one it gives for " +
      "its other speech models. The default base URL is the shared DashScope host, which Alibaba " +
      "puts into maintenance mode on 30 September 2026; it recommends your workspace's own " +
      "(https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com) instead. " +
      RATES_AS_OF,
    apply: {
      name: label,
      baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
      model,
      needsKey: true,
      price: rate,
      billing: { unit: "chars", rate },
      maxChars: 600,
      splitAt: "sentence",
      // no documented concurrency; both models are 3 requests a second in Singapore, which 3 lines
      // at once cannot pass while each takes a second or more
      // (https://www.alibabacloud.com/help/en/model-studio/rate-limit)
      concurrency: 3,
      latency: 2000,
      failRate: 0.01,
    },
  };
}

/**
 * The vocal sounds Google recommends for its 3.8 speech models, written inline in angle brackets
 * where the sound should fall ("Vocal bursts and non-speech sounds" in its speech-generation
 * guide). Delivery — whispering, a tone, a pace — is not here: 3.8 takes that as the line's style,
 * beside the text. Ids are the shared names the demo's tags use, so an annotation made for one
 * model's "Sighs" is the same expression on this one.
 */
const GEMINI_VOCAL_TAGS: ExpressionTag[] = [
  { id: "laughs", label: "Laughs", token: "<laugh>", kind: "sound" },
  { id: "chuckles", label: "Chuckles", token: "<chuckle>", kind: "sound" },
  { id: "sighs", label: "Sighs", token: "<sigh>", kind: "sound" },
  { id: "gasps", label: "Gasps", token: "<gasp>", kind: "sound" },
  { id: "breathes", label: "Breathes", token: "<breath>", kind: "sound" },
  { id: "coughs", label: "Coughs", token: "<cough>", kind: "sound" },
  { id: "clears throat", label: "Clears throat", token: "<throat-clearing>", kind: "sound" },
  { id: "sobs", label: "Sobs", token: "<sob>", kind: "sound" },
  { id: "yawns", label: "Yawns", token: "<yawn>", kind: "sound" },
  { id: "groans", label: "Groans", token: "<groan>", kind: "sound" },
  { id: "pause", label: "Pause", token: "<short pause>", kind: "sound" },
  { id: "long pause", label: "Long pause", token: "<long pause>", kind: "sound" },
];

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * One of the Gemini 3.8 speech models, released on 22 September 2026. Billed like 3.1 — input text
 * tokens and output audio tokens, 25 audio tokens a second — at $1 in and `audioRate` out from
 * 2027; until then Google charges half, which a promotion holds so the card turns over by itself.
 * Its expression tags start as Google's recommended vocal sounds.
 */
function gemini38Tts(
  id: string,
  label: string,
  hint: string,
  model: string,
  audioRate: number,
  about: string,
): TtsPreset {
  return {
    id,
    group: "Google Gemini",
    label,
    hint,
    note:
      `${about} $${audioRate / 2} per million output audio tokens and $0.50 per million input ` +
      `text tokens until the end of 2026, then $${audioRate} and $1: the card is the 2027 rate ` +
      "and a promotion on the Pricing tab holds the 2026 one until it ends. A request takes up " +
      "to 8,192 input tokens. A line's style and direction go beside it as its style rather " +
      "than into the text, which 3.8 reads aloud word for word. Sounds such as <laugh>, <sigh> " +
      "or <short pause> go in the text; the Expressions tab starts with the ones Google " +
      "recommends. " +
      RATES_AS_OF,
    apply: {
      name: label,
      baseUrl: GEMINI_BASE_URL,
      model,
      needsKey: true,
      price: 0,
      billing: { unit: "audio-tokens", rate: 1, audioRate, audioTokensPerSecond: 25 },
      pricing: presetPricing({
        promotions: [
          {
            id: "gemini-tts-2026",
            label: "2026 price",
            from: null,
            until: Date.UTC(2027, 0, 1),
            scope: ["speech"],
            percent: 50,
            note: `Google's published 2026 rate for ${model}; the card rate applies from 1 January 2027.`,
          },
        ],
      }),
      maxChars: 5000,
      splitAt: "sentence",
      // no documented concurrency or rate: Google shows a project's speech-model limits only on
      // AI Studio's rate-limit page (https://ai.google.dev/gemini-api/docs/rate-limits), so one
      // line at a time until yours says more
      concurrency: 1,
      latency: 1800,
      failRate: 0.015,
      expressions: {
        status: "supported",
        model,
        baseUrl: GEMINI_BASE_URL,
        tags: GEMINI_VOCAL_TAGS.map((t) => ({ ...t })),
      },
    },
  };
}

export const TTS_PRESETS: TtsPreset[] = [
  {
    // first, since a fresh library has no endpoints and this is the one that works without an
    // account: its voices come with it, so a line can be rendered before anything is fetched
    id: "simulated",
    group: "Simulated",
    label: "Simulated (free)",
    hint: "a tone per line, answered by this server",
    note:
      "Answered by this server and never the network: each line comes back as a quiet tone, " +
      "pitched by its speaker, so a run can be tried end to end without an account. Nothing is " +
      "billed and no key is needed. How long an answer takes and how often one fails are set on " +
      "the Requests tab.",
    apply: {
      name: "Simulated (free)",
      baseUrl: SIMULATED_BASE_URL,
      model: SIMULATED_SPEECH_MODEL,
      needsKey: false,
      price: 0,
      billing: { unit: "chars", rate: 0 },
      voices: SIMULATED_VOICES.map((v) => ({ ...v })),
      encoding: { format: "wav" },
      maxChars: 0,
      splitAt: "sentence",
      concurrency: 4,
      latency: 800,
      failRate: 0,
    },
  },
  {
    id: "fish-free",
    group: "Fish Audio",
    label: "Fish Audio · S2.1 Pro Free",
    hint: "free tier, no hard character cap",
    note:
      "Free through 30 November 2026 under Fish Audio's fair-use policy, with no SLA and " +
      "best-effort latency. Requests may be used to improve their model, and products over " +
      "$1M ARR are asked to contact them first. A voice is a reference_id from your Fish Audio " +
      "library, not a named voice. " +
      RATES_AS_OF,
    apply: {
      name: "Fish Audio (free)",
      baseUrl: "https://api.fish.audio/v1",
      model: "s2.1-pro-free",
      needsKey: true,
      price: 0,
      billing: { unit: "bytes", rate: 0 },
      // no documented per-request cap; their own chunking tops out at 300 characters a chunk
      maxChars: 0,
      splitAt: "sentence",
      // the Starter tier, under $100 ever paid, which gives the free model no limit of its own;
      // 15 from $100
      // (https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits)
      concurrency: 5,
      latency: 1200,
      failRate: 0.02,
    },
  },
  {
    id: "fish-pro",
    group: "Fish Audio",
    label: "Fish Audio · S2.1 Pro",
    hint: "paid tier, same API",
    note:
      "Same endpoint and request shape as the free tier with a different `model` header. Billed " +
      "per million **UTF-8 bytes**: Fish's price list talks about characters, but the quantity it " +
      "meters is bytes, so a chapter of Mandarin costs about three times what a character count " +
      "suggests and an accented Latin name a little more than it looks. $15 per million is their " +
      "published figure — check it against your own plan. " +
      RATES_AS_OF,
    apply: {
      name: "Fish Audio",
      baseUrl: "https://api.fish.audio/v1",
      model: "s2.1-pro",
      needsKey: true,
      price: 0,
      billing: { unit: "bytes", rate: 15 },
      maxChars: 0,
      splitAt: "sentence",
      // the Starter tier, under $100 ever paid; 15 from $100, 50 from $1,000
      // (https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits)
      concurrency: 5,
      latency: 1100,
      failRate: 0.02,
    },
  },
  {
    id: "openai",
    group: "OpenAI",
    label: "OpenAI · gpt-4o-mini-tts",
    hint: "text tokens in, audio tokens out",
    note:
      "Billed $0.60 per million input text tokens and $12 per million output audio tokens. " +
      "OpenAI does not publish how many audio tokens a second of speech is, and its speech " +
      "endpoint reports no usage, so the audio half is worked out at this endpoint's " +
      "tokens-per-second setting on the Pricing tab — 25 here, Gemini's published figure, which " +
      "is an assumption for OpenAI and marked as one wherever it is used. Requests are kept to " +
      "1,500 characters: the endpoint takes 4,096, but the model reads at most 2,000 input " +
      "tokens, instructions included. " +
      RATES_AS_OF,
    apply: {
      name: "OpenAI · gpt-4o-mini-tts",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      needsKey: true,
      price: 0,
      billing: { unit: "audio-tokens", rate: 0.6, audioRate: 12, audioTokensPerSecond: 25 },
      maxChars: 1500,
      splitAt: "sentence",
      // no documented concurrency; Tier 1 is 500 RPM and 50,000 TPM, and 5 lines at once keep short
      // lines under both (https://developers.openai.com/api/docs/models/gpt-4o-mini-tts)
      concurrency: 5,
      latency: 1400,
      failRate: 0.01,
    },
  },
  openaiTts1("tts-1", "OpenAI · tts-1", "per character, the older fast model", 15),
  openaiTts1("tts-1-hd", "OpenAI · tts-1-hd", "per character, the older quality model", 30),
  gemini38Tts(
    "gemini-3.8-flash-tts",
    "Gemini 3.8 Flash TTS",
    "flagship, made for audiobooks",
    "gemini-3.8-flash-tts",
    18,
    "Google's flagship speech model, pitched at audiobooks, multi-speaker scenes and dialects, " +
      "in 130 languages.",
  ),
  gemini38Tts(
    "gemini-3.8-flash-lite-tts",
    "Gemini 3.8 Flash-Lite TTS",
    "cheaper, replaces 3.1 Flash TTS",
    "gemini-3.8-flash-lite-tts",
    12,
    "Google's cheaper speech model, built to replace 3.1 Flash TTS, in 101 languages.",
  ),
  {
    id: "gemini-tts",
    group: "Google Gemini",
    label: "Gemini 3.1 Flash TTS (legacy)",
    hint: "preview Google now calls legacy — use 3.8 Flash-Lite",
    note:
      "Google now lists this preview as legacy and points to 3.8 Flash-Lite TTS, which costs less; " +
      "no shutdown date is announced. " +
      "Two rates, priced separately: $1 per million input text tokens and $20 per million output " +
      "audio tokens. The audio side is the one that dominates a bill, and it does not follow from " +
      "the text — an estimate has to go through the audio's expected length and a tokens-per-second " +
      "figure, which is editable on the Pricing tab because it is an assumption about the " +
      "provider's tokeniser rather than something this app can measure. A preview has no field " +
      "for a line's style or direction, so neither is sent. " +
      RATES_AS_OF,
    apply: {
      name: "Gemini 3.1 Flash TTS",
      baseUrl: GEMINI_BASE_URL,
      model: "gemini-3.1-flash-tts-preview",
      needsKey: true,
      price: 0,
      billing: {
        unit: "audio-tokens",
        rate: 1,
        audioRate: 20,
        audioTokensPerSecond: 25,
      },
      maxChars: 5000,
      splitAt: "sentence",
      // no documented concurrency or rate: Google shows a project's speech-model limits only on
      // AI Studio's rate-limit page (https://ai.google.dev/gemini-api/docs/rate-limits), so one
      // line at a time until yours says more
      concurrency: 1,
      latency: 1800,
      failRate: 0.015,
    },
  },
  elevenLabs(
    "eleven_v3",
    "ElevenLabs · Eleven v3",
    "most expressive, takes [audio tags]",
    80,
    5000,
  ),
  elevenLabs(
    "eleven_multilingual_v2",
    "ElevenLabs · Multilingual v2",
    "steady long-form narration",
    80,
    10000,
  ),
  elevenLabs("eleven_flash_v2_5", "ElevenLabs · Flash v2.5", "fast, half the price", 40, 40000),
  breezeTts(
    "breeze-tts-2",
    "BreezeBlue · Breeze TTS 2",
    "English and Chinese, delivery as instructions",
    "English and Chinese.",
  ),
  breezeTts(
    "breeze-tts-2-multilingual",
    "BreezeBlue · Breeze TTS 2 Multilingual",
    "51 languages",
    "51 languages.",
  ),
  miniMax("speech-2.8-hd", "MiniMax · Speech 2.8 HD", "richest quality", 100),
  miniMax("speech-2.8-turbo", "MiniMax · Speech 2.8 Turbo", "faster, 40% cheaper", 60),
  {
    id: "cartesia-sonic-3.6",
    group: "Cartesia",
    label: "Cartesia · Sonic 3.6",
    hint: "44 languages, tags in the transcript",
    note:
      "Billed in credits, about one a character: $50 per million characters on the Pro plan " +
      "($5 for 100,000), less on larger plans — Startup $39, Scale $37 — so set the rate to your " +
      "own plan's. Failed requests cost nothing. Delivery goes in the text as [laughter], " +
      '<break time="1s"/> or <emotion value="calm"/>, set up on the Expressions tab. A voice is ' +
      "a voice id from Cartesia; Fetch lists them. Cartesia documents no per-request limit. " +
      "Rates as published on 28 September 2026.",
    apply: {
      name: "Cartesia · Sonic 3.6",
      baseUrl: "https://api.cartesia.ai",
      model: "sonic-3.6",
      needsKey: true,
      price: 50,
      billing: { unit: "chars", rate: 50 },
      maxChars: 0,
      splitAt: "sentence",
      // the Pro plan's limit for speech, the plan its rate is; Startup allows 5, Scale 15
      // (https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts)
      concurrency: 3,
      latency: 900,
      failRate: 0.01,
    },
  },
  qwenTts(
    "qwen-audio-3.0-tts-plus",
    "Alibaba · Qwen-Audio 3.0 TTS Plus",
    "higher quality, 2 system voices",
    20,
  ),
  qwenTts(
    "qwen-audio-3.0-tts-flash",
    "Alibaba · Qwen-Audio 3.0 TTS Flash",
    "cheaper, 12 system voices",
    15,
  ),
  {
    id: "compatible",
    group: "On your machine",
    label: "OpenAI-compatible server · Kokoro",
    hint: "Kokoro-FastAPI on :8880; an Orpheus or Piper bridge too",
    apply: {
      name: "Kokoro (local)",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      needsKey: false,
      price: 0,
      billing: { unit: "chars", rate: 0 },
      maxChars: 500,
      splitAt: "sentence",
      // a local server has no published limit: what it holds depends on the machine and the model
      concurrency: 2,
      latency: 2600,
      failRate: 0.025,
    },
  },
  {
    id: "vllm-omni",
    group: "On your machine",
    label: "OpenAI-compatible server · vLLM-Omni",
    hint: "open speech models on :8091 — Fish S2 Pro, Qwen3-TTS, Voxtral",
    note:
      "vLLM-Omni serves open speech models over OpenAI's /audio/speech, started with " +
      "`vllm serve <repo> --omni --port 8091`. The model is the Hugging Face repo you served — " +
      "fishaudio/s2-pro here; Qwen/Qwen3-TTS and mistralai/Voxtral-4B-TTS are others. Its " +
      "sample rate is the model's own (44.1 kHz for Fish S2, 24 kHz for most), so leave the rate " +
      "unset. Nothing is billed.",
    apply: {
      name: "vLLM-Omni (local)",
      baseUrl: "http://127.0.0.1:8091/v1",
      model: "fishaudio/s2-pro",
      needsKey: false,
      price: 0,
      billing: { unit: "chars", rate: 0 },
      maxChars: 500,
      splitAt: "sentence",
      // a local server has no published limit: what it holds depends on the machine and the model
      concurrency: 2,
      latency: 2600,
      failRate: 0.025,
    },
  },
  {
    id: "omnivoice",
    group: "On your machine",
    label: "OmniVoice server · batches",
    hint: "omnivoice-fastapi on :8000, many lines a request",
    note:
      "omnivoice-fastapi speaks the batch speech API, so a run sends it many lines a request; " +
      "the Requests tab says how many it takes and switches batches off. Voices live on the " +
      "server — Fetch lists them, and the Voices tab clones new ones from a recording. Lines " +
      "over 1,500 characters are split, the server's own limit. Nothing is billed.",
    apply: {
      name: "OmniVoice (local)",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "omnivoice",
      makesVoices: true,
      needsKey: false,
      price: 0,
      billing: { unit: "chars", rate: 0 },
      maxChars: 1500,
      splitAt: "sentence",
      // the server renders on one model thread, so a second batch only waits behind the first
      concurrency: 1,
      latency: 4000,
      failRate: 0.025,
    },
  },
];
