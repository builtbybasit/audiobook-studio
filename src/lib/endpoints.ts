// One vocabulary for both kinds of endpoint.
//
// The app has always had two separate lists: `profiles` (chat models that turn prose into a script)
// and `endpoints` (speech models that render a line). They are configured, paused, rate limited and
// billed the same way, so the Endpoints page reads them through the one shape below. Ids are only
// unique *within* a kind — there is an "openai" in both lists — so everything here is keyed by
// `<kind>:<id>`.
//
// Nothing in this file mutates the two lists; it adapts them. The only exception is `ensureOps`,
// which fills in operational defaults for an endpoint saved before those fields existed.
import type {
  Endpoint,
  EndpointKind,
  EndpointOps,
  MetricTotals,
  Profile,
  TtsBilling,
  WaitReason,
} from "@/types";
import { profileErrors } from "@/lib/scripting";
import { OPS_DEFAULTS, encodingProblems } from "@/lib/endpointShapes";
import { keyring } from "@/lib/keyring";
import {
  baseRates,
  billingProblems,
  effectiveRates,
  ensurePricing,
  newPricing,
  pricingOneLiner,
  pricingProblems,
  speechPricingOf,
  speechRateKnown,
} from "@/lib/pricing";

export {
  KIND_PATH,
  OPS_DEFAULTS,
  fishModelsUrl,
  isFishAudio,
  ttsRequestPath,
  voicesFromFishModels,
  type FishModel,
} from "@/lib/endpointShapes";

/** Fill in operational defaults in place. Idempotent — only absent fields are written. */
export function ensureOps<T extends Profile | Endpoint>(ep: T, kind: EndpointKind): T {
  const defaults = OPS_DEFAULTS[kind] as unknown as Record<string, unknown>;
  const target = ep as unknown as Record<string, unknown>;
  for (const k of Object.keys(defaults)) if (target[k] === undefined) target[k] = defaults[k];
  return ep;
}

export interface UnifiedEndpoint {
  /** `<kind>:<id>` — unique across both lists */
  key: string;
  id: string;
  kind: EndpointKind;
  name: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  needsKey: boolean;
  concurrency: number;
  /** keyring slot this endpoint's key lives in */
  slot: string;
  backoffUntil: number;
  /** exactly one of these is set; the tabs edit it directly */
  profile: Profile | null;
  endpoint: Endpoint | null;
}

export const scriptingSlot = (id: string): string => "profile:" + id;

export function unifyProfile(p: Profile): UnifiedEndpoint {
  return {
    key: "scripting:" + p.id,
    id: p.id,
    kind: "scripting",
    name: p.name,
    model: p.model,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    needsKey: p.needsKey,
    concurrency: p.concurrency,
    slot: scriptingSlot(p.id),
    backoffUntil: 0,
    profile: p,
    endpoint: null,
  };
}

export function unifyEndpoint(e: Endpoint): UnifiedEndpoint {
  return {
    key: "tts:" + e.id,
    id: e.id,
    kind: "tts",
    name: e.name,
    model: e.model,
    baseUrl: e.baseUrl,
    enabled: e.enabled,
    needsKey: e.needsKey,
    concurrency: e.concurrency,
    slot: e.id,
    backoffUntil: e.backoffUntil,
    profile: null,
    endpoint: e,
  };
}

export const opsOf = (u: UnifiedEndpoint): EndpointOps =>
  ({ ...OPS_DEFAULTS[u.kind], ...(u.profile ?? u.endpoint) }) as EndpointOps;

export const KIND_LABEL: Record<EndpointKind, string> = {
  scripting: "Scripting",
  tts: "Text to speech",
};

// ---------- presets ----------

/** What a provider's "add this endpoint" form should be filled in with. Everything here is a
 *  starting point the user can still edit; only fields a provider genuinely pins down are set.
 *  Prices are the provider's published card on the date beside them — check them against your
 *  own plan, since a budget is held to them. */
export interface Preset<T> {
  id: string;
  label: string;
  hint: string;
  /** shown under the picker once chosen — the caveat that belongs with this choice */
  note?: string;
  /** the heading it is listed under in the picker, when a kind has enough presets to need them */
  group?: string;
  apply: Partial<T>;
}
export type TtsPreset = Preset<Endpoint>;
/** A chat model the scripting queue can send a chapter to: anything serving OpenAI's
 *  `/chat/completions`, which is the only request shape the scripting provider makes. */
export type ScriptingPreset = Preset<Profile>;

export const TTS_PRESETS: TtsPreset[] = [
  {
    id: "fish-free",
    label: "Fish Audio · S2.1 Pro Free",
    hint: "free tier, no hard character cap",
    note:
      "Free through 30 November 2026 under Fish Audio's fair-use policy, with no SLA and " +
      "best-effort latency. Requests may be used to improve their model, and products over " +
      "$1M ARR are asked to contact them first. A voice is a reference_id from your Fish Audio " +
      "library, not a named voice.",
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
      concurrency: 4,
      latency: 1200,
      failRate: 0.02,
    },
  },
  {
    id: "fish-pro",
    label: "Fish Audio · S2.1 Pro",
    hint: "paid tier, same API",
    note:
      "Same endpoint and request shape as the free tier with a different `model` header. Billed " +
      "per million **UTF-8 bytes**: Fish's price list talks about characters, but the quantity it " +
      "meters is bytes, so a chapter of Mandarin costs about three times what a character count " +
      "suggests and an accented Latin name a little more than it looks. $15 per million is their " +
      "published figure — check it against your own plan.",
    apply: {
      name: "Fish Audio",
      baseUrl: "https://api.fish.audio/v1",
      model: "s2.1-pro",
      needsKey: true,
      price: 0,
      billing: { unit: "bytes", rate: 15 },
      maxChars: 0,
      splitAt: "sentence",
      concurrency: 4,
      latency: 1100,
      failRate: 0.02,
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    hint: "gpt-4o-mini-tts",
    apply: {
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      needsKey: true,
      price: 12,
      billing: { unit: "chars", rate: 12 },
      maxChars: 4096,
      splitAt: "sentence",
      concurrency: 3,
      latency: 1400,
      failRate: 0.01,
    },
  },
  {
    id: "gemini-tts",
    label: "Gemini 3.1 Flash TTS Preview",
    hint: "input text tokens + output audio tokens",
    note:
      "Two rates, priced separately: $1 per million input text tokens and $20 per million output " +
      "audio tokens. The audio side is the one that dominates a bill, and it does not follow from " +
      "the text — an estimate has to go through the audio's expected length and a tokens-per-second " +
      "figure, which is editable on the Pricing tab because it is an assumption about the " +
      "provider's tokeniser rather than something this app can measure.",
    apply: {
      name: "Gemini 3.1 Flash TTS",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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
      concurrency: 2,
      latency: 1800,
      failRate: 0.015,
    },
  },
  {
    id: "compatible",
    label: "OpenAI-compatible server",
    hint: "Kokoro-FastAPI, Orpheus, a Piper bridge",
    apply: {
      name: "Local server",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      needsKey: false,
      price: 0,
      billing: { unit: "chars", rate: 0 },
      maxChars: 500,
      splitAt: "sentence",
      concurrency: 2,
      latency: 2600,
      failRate: 0.025,
    },
  },
];

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
 * model (`GET /api/v1/models`), standard tier — the underlying provider's price passed through.
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
      "Through OpenRouter, which passes the model's own price through; buying credits adds " +
      "OpenRouter's fee (5.5%, at least $0.80), which these rates leave out. One of the most-used " +
      "models on OpenRouter in the week to 27 September 2026. " +
      PRICES_AS_OF,
    apply: {
      name: `OpenRouter · ${label}`,
      baseUrl: "https://openrouter.ai/api/v1",
      model,
      needsKey: true,
      inPrice: rates.input,
      outPrice: rates.output,
      pricing: newPricing({ cachedInput: rates.cachedInput, cacheWrite: rates.cacheWrite }),
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
      pricing: newPricing({ cachedInput: 0.01, cacheWrite: 0.125 }),
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
      pricing: newPricing({ cachedInput: 0.2, cacheWrite: 2.5 }),
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
      pricing: newPricing({ cachedInput: 1, cacheWrite: 12.5 }),
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
      pricing: newPricing({
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
      pricing: newPricing({
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
      pricing: newPricing({ cachedInput: 0.2, cacheWrite: null }),
    },
  },
  {
    id: "anthropic-opus",
    group: "Anthropic",
    label: "Anthropic · Claude Opus 5.5",
    hint: "claude-opus-5-5, through its OpenAI compatibility layer",
    note:
      "Anthropic's most capable model, at twice Sonnet's price. The same caveat as Sonnet: " +
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
      pricing: newPricing(),
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
      pricing: newPricing(),
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
      pricing: newPricing(),
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
      pricing: newPricing({ cachedInput: 0.5, cacheWrite: null }),
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
      pricing: newPricing({ cachedInput: 0.2, cacheWrite: null }),
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
  openRouter(
    "claude-fable-5.1",
    "Claude Fable 5.1",
    "anthropic/claude-fable-5.1",
    "anthropic/claude-fable-5.1",
    {
      input: 10,
      output: 50,
      cachedInput: 0.25,
      cacheWrite: 12.5,
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
      pricing: newPricing(),
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
      pricing: newPricing(),
    },
  },
];

/** The presets for one kind of endpoint. */
export function presetsOf(kind: "tts"): TtsPreset[];
export function presetsOf(kind: "scripting"): ScriptingPreset[];
export function presetsOf(kind: EndpointKind): (TtsPreset | ScriptingPreset)[];
export function presetsOf(kind: EndpointKind): (TtsPreset | ScriptingPreset)[] {
  return kind === "tts" ? TTS_PRESETS : SCRIPTING_PRESETS;
}

export const presetById = (id: string): TtsPreset | undefined =>
  TTS_PRESETS.find((p) => p.id === id);

export const scriptingPresetById = (id: string): ScriptingPreset | undefined =>
  SCRIPTING_PRESETS.find((p) => p.id === id);

// ---------- billing ----------
// The units, the conversion and the arithmetic live in `lib/pricing.ts`, beside the schedules and
// promotions that move a speech rate too. Import them from there; this file adapts an `Endpoint`
// onto them and does no pricing arithmetic of its own.

/** This endpoint's billing model. An endpoint saved before billing models existed carried one
 *  per-1M-characters number, which is exactly what `chars` means, so that is what it becomes. */
export const billingOf = (e: Endpoint): TtsBilling => e.billing ?? { unit: "chars", rate: e.price };

/** The whole speech rate card — the rate, its unit, and the schedule and promotions on it. */
export const speechPricing = (e: Endpoint) => speechPricingOf({ ...e, billing: billingOf(e) });

// ---------- money ----------

/** The one-line pricing shown on a card — at the rates in force now, not the base card. */
export function pricingLabel(u: UnifiedEndpoint, now: number = Date.now()): string {
  if (u.profile) {
    const { inPrice, outPrice } = u.profile;
    if (!inPrice && !outPrice) return "no rates entered";
    return pricingOneLiner(effectiveRates(baseRates(u.profile), ensurePricing(u.profile), now));
  }
  const { base, config, unit } = speechPricing(u.endpoint!);
  return pricingOneLiner(effectiveRates(base, config, now), unit);
}

/** True when we cannot price this endpoint's requests at all — including a two-rate endpoint with
 *  only one of its two rates filled in, which prices nothing rather than half of each request. */
export const unpriced = (u: UnifiedEndpoint): boolean =>
  u.endpoint ? !speechRateKnown(billingOf(u.endpoint)) : false;

// ---------- health ----------

export type HealthState =
  | "paused"
  | "misconfigured"
  | "nokey"
  | "cooldown"
  | "failing"
  | "degraded"
  | "healthy"
  | "idle"
  | "untested";

export type HealthTone = "good" | "warn" | "bad" | "muted";

export interface Health {
  state: HealthState;
  label: string;
  tone: HealthTone;
  /** one sentence saying what was observed, and what to do about it */
  detail: string;
}

export interface HealthInput {
  hasKey: boolean;
  errors: string[];
  now: number;
  /** metrics for the selected range, or null while they load */
  totals: MetricTotals | null;
  /** when this endpoint last answered anything, ever */
  lastSeen: number | null;
  /** an explicit connection test has been run at least once */
  tested: boolean;
}

const TONE: Record<HealthState, HealthTone> = {
  paused: "muted",
  misconfigured: "warn",
  nokey: "warn",
  cooldown: "warn",
  failing: "bad",
  degraded: "warn",
  healthy: "good",
  idle: "muted",
  untested: "muted",
};

/** Observed health. An endpoint that has done nothing is never called healthy — it is "Not tested"
 *  until something has actually answered, and "No recent activity" after it falls quiet. */
export function healthOf(u: UnifiedEndpoint, input: HealthInput): Health {
  const mk = (state: HealthState, label: string, detail: string): Health => ({
    state,
    label,
    tone: TONE[state],
    detail,
  });
  if (!u.enabled)
    return mk(
      "paused",
      "Paused",
      "No new requests are dispatched. Requests already in flight finish normally.",
    );
  if (input.errors.length) return mk("misconfigured", "Check settings", input.errors[0]);
  if (u.needsKey && !input.hasKey)
    return mk(
      "nokey",
      "Key needed",
      u.kind === "scripting"
        ? "This endpoint requires a key. Runs can’t start on it until one is set."
        : "This endpoint requires a key. Lines routed here fail until one is set.",
    );
  const cooling = Math.ceil((u.backoffUntil - input.now) / 1000);
  if (cooling > 0)
    return mk(
      "cooldown",
      `Cooling down ${cooling}s`,
      "The provider rate limited us. Dispatch resumes automatically when the cooldown ends.",
    );
  const t = input.totals;
  if (!t || !t.requests) {
    if (input.lastSeen)
      return mk(
        "idle",
        "No recent activity",
        `Nothing in the selected range. Last answered ${relative(input.lastSeen, input.now)}.`,
      );
    return mk(
      input.tested ? "idle" : "untested",
      input.tested ? "No recent activity" : "Not tested",
      input.tested
        ? "The connection test passed, but no request has been sent through it yet."
        : "Nothing has been sent through this endpoint. Run a connection test to check it.",
    );
  }
  const eventual = t.eventualOk / t.requests;
  const first = t.firstAttemptOk / t.requests;
  if (eventual < 0.6)
    return mk(
      "failing",
      "Failing",
      `${Math.round((1 - eventual) * 100)}% of requests in this range never succeeded. Check the Activity tab for the errors.`,
    );
  if (first < 0.85 || t.rateLimits > 0)
    return mk(
      "degraded",
      "Degraded",
      t.rateLimits
        ? `${t.rateLimits} rate limit${t.rateLimits === 1 ? "" : "s"} in this range — retries are absorbing them. Lower concurrency to stop hitting the ceiling.`
        : `${Math.round((1 - first) * 100)}% of requests needed a retry. They are succeeding, just not first time.`,
    );
  return mk(
    "healthy",
    "Healthy",
    `${t.requests} request${t.requests === 1 ? "" : "s"} in this range, ${Math.round(first * 100)}% right first time.`,
  );
}

export const DOT: Record<HealthTone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  muted: "bg-zinc-400",
};
export const TEXT: Record<HealthTone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  muted: "text-zinc-500",
};

// ---------- waiting ----------

export const WAIT_LABEL: Record<WaitReason, string> = {
  paused: "Endpoint paused",
  concurrency: "Concurrency full",
  cooldown: "Rate-limit cooldown",
  nokey: "No credential",
  budget: "Budget exhausted",
  ordered: "Waiting its turn",
};

export const WAIT_DETAIL: Record<WaitReason, string> = {
  paused: "You paused this endpoint. Resume it to start dispatching again.",
  concurrency:
    "Every configured slot is busy. This request goes out as soon as one of them frees up.",
  cooldown: "The provider returned 429. Dispatch is held off until the cooldown ends.",
  nokey:
    "This endpoint requires a key and none is set. Add one in the Connection tab, then retry — unlike a pause, a missing key fails the request rather than holding it.",
  budget:
    "The remaining budget can’t cover this request. Raise the endpoint limit or the book budget to release it.",
  ordered:
    "Chapters of one book run in order — an earlier chapter is still going through this endpoint.",
};

// ---------- formatting helpers shared by the page ----------

export function relative(ts: number, now: number): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const clockOf = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export const compact = (n: number): string =>
  n >= 1e6
    ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M"
    : n >= 1000
      ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k"
      : String(Math.round(n));

/** A rate that may be tiny (0.045 audio minutes a minute) or huge (12k tokens a minute) and has to
 *  stay readable at both ends — `compact` alone rounds the small end away to "0". */
export const metricValue = (n: number): string =>
  n === 0
    ? "0"
    : n >= 1000
      ? compact(n)
      : n >= 10
        ? n.toFixed(0)
        : n >= 1
          ? n.toFixed(1)
          : n.toFixed(n < 0.1 ? 3 : 2);

/** Unit of the throughput metric, which differs by kind. */
export const throughputUnit = (kind: EndpointKind): string =>
  kind === "scripting" ? "tokens/min" : "audio min/min";

export const throughputLabel = (kind: EndpointKind): string =>
  kind === "scripting" ? "Tokens per minute" : "Generated audio minutes per minute";

/** Validation errors for either kind, reusing the scripting rules where they apply. */
export function endpointErrors(u: UnifiedEndpoint): string[] {
  if (u.profile) return profileErrors(u.profile);
  const e = u.endpoint!;
  const errors: string[] = [];
  try {
    const url = new URL(e.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    if (/\/audio\/speech\/?$/.test(url.pathname))
      errors.push("Use the base URL without /audio/speech.");
  } catch {
    errors.push("Enter a valid HTTP or HTTPS base URL.");
  }
  if (!e.name.trim()) errors.push("Give this endpoint a name.");
  if (!e.model.trim()) errors.push("Enter a model ID.");
  if (!Number.isSafeInteger(e.concurrency) || e.concurrency < 1)
    errors.push("Concurrency must be a whole number of at least 1.");
  if (!Number.isSafeInteger(e.maxChars) || e.maxChars < 0)
    errors.push("Maximum characters must be zero or a positive whole number.");
  if (!e.voices.length) errors.push("No voices yet — fetch or add one before this can render.");
  // The rate card is validated on both kinds. A scripting profile gets this through
  // `profileErrors`; leaving it out here let an imported speech endpoint keep a malformed window, a
  // duplicate promotion id or an end date before its start, and stay enabled with it.
  errors.push(...pricingProblems(ensurePricing(e)));
  errors.push(...billingProblems(billingOf(e)));
  // The server refuses a line whose format, bitrate and rate cannot be asked for together, so an
  // endpoint set up that way (imported, or saved before the base URL moved) is not ready either.
  errors.push(...encodingProblems(e).map((p) => p + "."));
  return errors;
}

export const hasKeyFor = (u: UnifiedEndpoint): boolean => keyring.has(u.slot);

/** Redact anything that looks like a credential before an error body is shown or copied. A key
 *  echoed back in a provider's error message must not become the thing you paste into an issue. */
export function sanitize(text: string): string {
  return text
    .replace(/\b(sk|rk|pk|api|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "$1-[redacted]")
    .replace(
      /("(?:api_?key|authorization|token|secret|password)"\s*:\s*")[^"]*"/gi,
      '$1[redacted]"',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}
