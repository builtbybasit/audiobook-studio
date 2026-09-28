// The scripting presets: what "Start from a preset…" offers a scripting endpoint, grouped by
// provider — every one a model that serves OpenAI's /chat/completions.
import { presetPricing, type ScriptingPreset } from "@/lib/presets/preset";

// Every hosted rate below is the provider's own published card as read on 2026-09-28, standard
// tier, USD per million tokens. A preset leaves limits and timing at `newProfile`'s defaults: a
// provider's output ceiling is far above what a chunk of one chapter asks for.

const PRICES_AS_OF = "Rates as published on 28 September 2026 — check them against your own plan.";

/**
 * DeepSeek's peak hours, in UTC, Monday to Friday: 01:00–04:00 and 06:00–10:00. Every other hour
 * is off-peak at half price, so the card is the off-peak rate and these windows put the full one
 * back. Chinese public holidays are off-peak too; a schedule cannot know them, so they are billed
 * here at the peak rate, which overstates rather than understates.
 */
function deepseekPeaks(peak: { input: number; output: number; cachedInput: number }) {
  const weekdays = [1, 2, 3, 4, 5];
  return [
    { id: "peak-early", label: "Peak (01–04 UTC)", days: weekdays, from: 60, to: 240, rates: peak },
    {
      id: "peak-morning",
      label: "Peak (06–10 UTC)",
      days: weekdays,
      from: 360,
      to: 600,
      rates: peak,
    },
  ];
}

/** Gemini 3.8 Flash's 2026 price: half the card until 2027 begins (read as UTC midnight). */
const GEMINI_FLASH_2026 = {
  id: "flash-2026",
  label: "2026 price",
  from: null,
  until: Date.UTC(2027, 0, 1),
  scope: ["model" as const],
  percent: 50,
  note: "Google's published 2026 rate for gemini-3.8-flash; the card rate applies from 1 January 2027.",
};

/**
 * A model through OpenRouter, one key for all of them. Its rates are OpenRouter's listing for the
 * model (`GET /api/v1/models`), standard tier. That is not always the provider's own card, nor what
 * a request is charged: OpenRouter bills at the rate of whichever of its providers serves it, and
 * reports that charge with each answer as `usage.cost`, which is what the ledger records the
 * request as costing, with the figure worked out from these rates kept beside it.
 */
function openRouter(
  id: string,
  label: string,
  model: string,
  hint: string,
  rates: { input: number; output: number; cachedInput: number | null; cacheWrite: number | null },
): ScriptingPreset {
  return {
    id: `openrouter-${id}`,
    group: "OpenRouter",
    label: `OpenRouter · ${label}`,
    hint,
    note:
      "Through OpenRouter, at its listed rates for the model. A listing need not match the " +
      "provider's own card, and a request is billed at whichever provider serves it: Grok 4.7 is " +
      "listed at $1.60 / $4.80 against xAI's own $2 / $6, and the only provider serving it on 28 " +
      "September charged $3.20 / $9.60. OpenRouter reports what each request cost, and that is " +
      "the cost recorded; these rates price estimates and budgets. Buying credits adds " +
      "OpenRouter's fee (5.5%, at least $0.80), which these rates leave out. One of the top " +
      "models on OpenRouter's Artificial Analysis Intelligence Index list on 28 September 2026. " +
      PRICES_AS_OF,
    apply: {
      name: `OpenRouter · ${label}`,
      baseUrl: "https://openrouter.ai/api/v1",
      model,
      needsKey: true,
      inPrice: rates.input,
      outPrice: rates.output,
      pricing: presetPricing({ cachedInput: rates.cachedInput, cacheWrite: rates.cacheWrite }),
    },
  };
}

export const SCRIPTING_PRESETS: ScriptingPreset[] = [
  {
    id: "openai-luna",
    group: "OpenAI",
    label: "OpenAI · GPT-6 Luna",
    hint: "gpt-6-luna — cheapest, for high-volume work",
    note:
      "OpenAI's most efficient GPT-6 model, which is what scripting a book chapter by chapter " +
      "wants. Prompts over 272K input tokens cost more, which no chunk here comes near. " +
      PRICES_AS_OF,
    apply: {
      name: "OpenAI · GPT-6 Luna",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6-luna",
      needsKey: true,
      inPrice: 0.1,
      outPrice: 0.5,
      pricing: presetPricing({ cachedInput: 0.01, cacheWrite: 0.125 }),
    },
  },
  {
    id: "openai-sol",
    group: "OpenAI",
    label: "OpenAI · GPT-6 Sol",
    hint: "gpt-6-sol — the middle of the three",
    note:
      "Twenty times Luna, a fifth of Astra; OpenAI pitches it at coding and agentic work. " +
      "Prompts over 272K input tokens cost more, which no chunk here comes near. " +
      PRICES_AS_OF,
    apply: {
      name: "OpenAI · GPT-6 Sol",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6-sol",
      needsKey: true,
      inPrice: 2,
      outPrice: 10,
      pricing: presetPricing({ cachedInput: 0.2, cacheWrite: 2.5 }),
    },
  },
  {
    id: "openai-astra",
    group: "OpenAI",
    label: "OpenAI · GPT-6 Astra",
    hint: "gpt-6-astra — flagship, a hundred times Luna",
    note: PRICES_AS_OF,
    apply: {
      name: "OpenAI · GPT-6 Astra",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6-astra",
      needsKey: true,
      inPrice: 10,
      outPrice: 50,
      pricing: presetPricing({ cachedInput: 1, cacheWrite: 12.5 }),
    },
  },
  {
    id: "deepseek-flash",
    group: "DeepSeek",
    label: "DeepSeek · V4.1 Flash",
    hint: "deepseek-flash — half price off-peak",
    note:
      "Half price outside DeepSeek's peak hours (01:00–04:00 and 06:00–10:00 UTC on weekdays), " +
      "which the schedule on the Pricing tab already holds. Thinking mode is on by default and " +
      "its tokens are billed as output. " +
      PRICES_AS_OF,
    apply: {
      name: "DeepSeek · V4.1 Flash",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      needsKey: true,
      inPrice: 0.15,
      outPrice: 0.6,
      pricing: presetPricing({
        cachedInput: 0.003,
        cacheWrite: null,
        timezone: "UTC",
        windows: deepseekPeaks({ input: 0.3, output: 1.2, cachedInput: 0.006 }),
      }),
    },
  },
  {
    id: "gemini-flash",
    group: "Google Gemini",
    label: "Gemini · 3.8 Flash",
    hint: "gemini-3.8-flash — price doubles on 1 Jan 2027",
    note:
      "Through Google's OpenAI compatibility layer, which Google still calls beta. $0.75 in / " +
      "$3.75 out until the end of 2026, then $1.50 / $7.50: the card is the 2027 rate and a " +
      "promotion on the Pricing tab holds the 2026 one until it ends. Reasoning cannot be turned " +
      "off, and its tokens are billed as output. " +
      PRICES_AS_OF,
    apply: {
      name: "Gemini · 3.8 Flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.8-flash",
      needsKey: true,
      inPrice: 1.5,
      outPrice: 7.5,
      pricing: presetPricing({
        cachedInput: 0.15,
        cacheWrite: null,
        promotions: [GEMINI_FLASH_2026],
      }),
    },
  },
  {
    id: "gemini-pro",
    group: "Google Gemini",
    label: "Gemini · 3.1 Pro (preview)",
    hint: "gemini-3.1-pro-preview",
    note:
      "A preview model, through Google's beta OpenAI compatibility layer. These are the rates for " +
      "prompts of 200K tokens or fewer, which every chunk here is. " +
      PRICES_AS_OF,
    apply: {
      name: "Gemini · 3.1 Pro",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.1-pro-preview",
      needsKey: true,
      inPrice: 2,
      outPrice: 12,
      pricing: presetPricing({ cachedInput: 0.2, cacheWrite: null }),
    },
  },
  {
    id: "anthropic-opus",
    group: "Anthropic",
    label: "Anthropic · Claude Opus 5.5",
    hint: "claude-opus-5-5, through its OpenAI compatibility layer",
    note:
      "The model Anthropic suggests starting with for most work, at twice Sonnet's price. The " +
      "same caveat as Sonnet: " +
      "Anthropic describes its OpenAI compatibility layer as meant for testing and comparing " +
      "models, and prompt caching is not available through it. " +
      PRICES_AS_OF,
    apply: {
      name: "Anthropic · Claude Opus 5.5",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-opus-5-5",
      needsKey: true,
      inPrice: 4,
      outPrice: 20,
      pricing: presetPricing(),
    },
  },
  {
    id: "anthropic-sonnet",
    group: "Anthropic",
    label: "Anthropic · Claude Sonnet 5",
    hint: "claude-sonnet-5, through its OpenAI compatibility layer",
    note:
      "Anthropic describes its OpenAI compatibility layer as meant for testing and comparing " +
      "models, not as a long-term or production-ready way in. Prompt caching is not available " +
      "through it, so no cached rate is set. " +
      PRICES_AS_OF,
    apply: {
      name: "Anthropic · Claude Sonnet 5",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-5",
      needsKey: true,
      inPrice: 2,
      outPrice: 10,
      pricing: presetPricing(),
    },
  },
  {
    id: "anthropic-haiku",
    group: "Anthropic",
    label: "Anthropic · Claude Haiku 4.5",
    hint: "claude-haiku-4-5, through its OpenAI compatibility layer",
    note:
      "The same caveat as Sonnet: a layer for testing and comparing, with no prompt caching. " +
      PRICES_AS_OF,
    apply: {
      name: "Anthropic · Claude Haiku 4.5",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-haiku-4-5",
      needsKey: true,
      inPrice: 1,
      outPrice: 5,
      pricing: presetPricing(),
    },
  },
  {
    id: "xai-grok-4.7",
    group: "xAI",
    label: "xAI · Grok 4.7",
    hint: "grok-4.7 — flagship, always reasons",
    note:
      "Reasoning cannot be turned off, and its tokens are billed as output. Every rate doubles " +
      "for a prompt of 200K tokens or more, which no chunk here comes near. xAI calls Chat " +
      "Completions its legacy API, still served. " +
      PRICES_AS_OF,
    apply: {
      name: "xAI · Grok 4.7",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.7",
      needsKey: true,
      inPrice: 2,
      outPrice: 6,
      pricing: presetPricing({ cachedInput: 0.5, cacheWrite: null }),
    },
  },
  {
    id: "xai-grok-4.3",
    group: "xAI",
    label: "xAI · Grok 4.3",
    hint: "grok-4.3 — fast and cheaper",
    note:
      "xAI's fast model, reasoning at low effort by default; the Grok 4 fast models retired in " +
      "May now answer as this one. Every rate doubles for a prompt of 200K tokens or more. " +
      PRICES_AS_OF,
    apply: {
      name: "xAI · Grok 4.3",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-4.3",
      needsKey: true,
      inPrice: 1.25,
      outPrice: 2.5,
      pricing: presetPricing({ cachedInput: 0.2, cacheWrite: null }),
    },
  },
  openRouter(
    "claude-opus-5.5",
    "Claude Opus 5.5",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-opus-5.5",
    {
      input: 4,
      output: 20,
      cachedInput: 0.2,
      cacheWrite: 5,
    },
  ),
  openRouter("gpt-6-astra", "GPT-6 Astra", "openai/gpt-6-astra", "openai/gpt-6-astra", {
    input: 10,
    output: 50,
    cachedInput: 1,
    cacheWrite: 12.5,
  }),
  openRouter("gpt-6-sol", "GPT-6 Sol", "openai/gpt-6-sol", "openai/gpt-6-sol", {
    input: 2,
    output: 10,
    cachedInput: 0.2,
    cacheWrite: 2.5,
  }),
  openRouter("grok-4.7", "Grok 4.7", "x-ai/grok-4.7", "x-ai/grok-4.7", {
    input: 1.6,
    output: 4.8,
    cachedInput: 0.4,
    cacheWrite: null,
  }),
  openRouter("qwen3.8-max", "Qwen3.8 Max", "qwen/qwen3.8-max-0902", "qwen/qwen3.8-max-0902", {
    input: 2,
    output: 6,
    cachedInput: 0.25,
    cacheWrite: 2.5,
  }),
  openRouter(
    "mimo-v2.6-pro",
    "MiMo-V2.6-Pro",
    "xiaomi/mimo-v2.6-pro",
    "xiaomi/mimo-v2.6-pro — cheapest of these",
    {
      input: 0.435,
      output: 0.87,
      cachedInput: 0.0036,
      cacheWrite: null,
    },
  ),
  {
    id: "ollama",
    group: "On your machine",
    label: "Ollama (local)",
    hint: "a model you have pulled, on localhost:11434",
    note:
      "Type the name of a model you have pulled (`ollama list`). Nothing is billed, and no key " +
      "is needed: Ollama ignores one.",
    apply: {
      name: "Ollama (local)",
      baseUrl: "http://localhost:11434/v1",
      model: "",
      needsKey: false,
      inPrice: 0,
      outPrice: 0,
      pricing: presetPricing(),
    },
  },
  {
    id: "lm-studio",
    group: "On your machine",
    label: "LM Studio (local)",
    hint: "its local server, on localhost:1234",
    note:
      "Type the id of the model LM Studio has loaded. Port 1234 is the one its docs use; change " +
      "it if yours differs. Nothing is billed.",
    apply: {
      name: "LM Studio (local)",
      baseUrl: "http://localhost:1234/v1",
      model: "",
      needsKey: false,
      inPrice: 0,
      outPrice: 0,
      pricing: presetPricing(),
    },
  },
];
