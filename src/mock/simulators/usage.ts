// What a provider hands back, in a provider's own shape.
//
// The point of this file is that nothing downstream gets to invent cache numbers. A simulated
// request builds a payload in whichever shape its provider uses, and that payload goes through
// `normalizeUsage` exactly as a real response would — so the normalizer, the "cached tokens are a
// slice of the input, not an addition to it" rule and the "not reported is not zero" rule are all
// exercised by the demo rather than only by the tests.
//
// Three shapes, because three shapes is what the real world has:
//
//   openai     `prompt_tokens` INCLUDES `prompt_tokens_details.cached_tokens`
//   anthropic  `input_tokens` EXCLUDES `cache_read_input_tokens` and `cache_creation_input_tokens`
//   plain      totals only, no cache detail at all — the case that must not read as "no cache"
import { normalizeSpeechUsage, normalizeUsage } from "@/lib/pricing";
import type {
  BillableUnits,
  SpeechUsage,
  SpeechUsageFormat,
  TokenUsage,
  UsageFormat,
} from "@/types";

/** Which payload shape an endpoint answers in. Chosen from the model id, the way a real client
 *  would choose a parser from the provider it was configured against. */
export function usageFormatFor(model: string, baseUrl: string): UsageFormat {
  const s = `${model} ${baseUrl}`.toLowerCase();
  if (/claude|anthropic/.test(s)) return "anthropic";
  // a small local server that reports totals and nothing else
  if (/localhost|127\.0\.0\.1|gemini|antigravity/.test(s)) return "plain";
  return "openai";
}

/**
 * Whether this provider reports a charge of its own.
 *
 * Some do — an aggregator bills per request and tells you what it billed. That number is not ours
 * to second-guess, so where it exists it is what the request is recorded at, and our own
 * calculation is kept beside it rather than thrown away. One definition, so the live simulator and
 * the seeded history agree about which endpoints behave this way.
 */
export const reportsOwnCost = (name: string, baseUrl: string): boolean =>
  /deepseek|openrouter/i.test(`${name} ${baseUrl}`);

/**
 * What such a provider says it charged, given what we make it.
 *
 * Deliberately not the same number: a provider's tokeniser and its rounding are not ours, so the
 * two figures never agree to the cent in real life either. The request detail shows both, which is
 * the whole reason for keeping them apart.
 */
export const reportedChargeFor = (calculated: number): number =>
  Math.round(calculated * 1.028 * 1e8) / 1e8;

export interface SimulatedResponse {
  /** the payload as the provider would have sent it, kept for the request's audit trail */
  raw: Record<string, unknown>;
  usage: TokenUsage;
}

export interface SimulatedUsageSpec {
  inputTokens: number;
  outputTokens: number;
  /** fraction of the input this request had cached, 0–1 */
  cacheHit: number;
  /** fraction of the input this request wrote into the cache, 0–1 */
  cacheWrite?: number;
  /** a charge the provider reports itself, when it reports one */
  reportedCost?: number;
  /** make the payload wrong on purpose, for the scenarios that have to survive it */
  corrupt?: "cache-exceeds-input" | "no-output" | "negative";
}

/**
 * Build a provider payload for one request and read it back through the normalizer.
 *
 * `cacheHit` is a fraction of the **total** input. A `plain` provider reports no cache detail at
 * all, so whatever fraction was actually cached is simply not visible — which is the point: the
 * request is then priced conservatively and labelled an estimate rather than being recorded as a
 * confident miss.
 */
export function simulateUsage(spec: SimulatedUsageSpec, format: UsageFormat): SimulatedResponse {
  const total = Math.max(0, Math.round(spec.inputTokens));
  const cached = Math.round(total * Math.min(1, Math.max(0, spec.cacheHit)));
  const written = Math.round(total * Math.min(1, Math.max(0, spec.cacheWrite ?? 0)));
  const output = Math.max(0, Math.round(spec.outputTokens));
  const cost = spec.reportedCost;

  let raw: Record<string, unknown>;
  if (format === "anthropic") {
    // input_tokens counts only what was neither read from nor written to the cache
    raw = {
      input_tokens: Math.max(0, total - cached - written),
      output_tokens: output,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: written,
    };
    if (spec.corrupt === "cache-exceeds-input") raw.cache_read_input_tokens = total + 250;
    if (spec.corrupt === "no-output") delete raw.output_tokens;
    if (spec.corrupt === "negative") raw.cache_read_input_tokens = -40;
  } else if (format === "plain") {
    raw = { prompt_tokens: total, completion_tokens: output };
    if (spec.corrupt === "no-output") delete raw.completion_tokens;
    if (spec.corrupt === "negative") raw.prompt_tokens = -total;
  } else {
    raw = {
      prompt_tokens: total,
      completion_tokens: output,
      total_tokens: total + output,
      prompt_tokens_details: { cached_tokens: cached },
    };
    if (spec.corrupt === "cache-exceeds-input")
      raw.prompt_tokens_details = { cached_tokens: total + 250 };
    if (spec.corrupt === "no-output") delete raw.completion_tokens;
    if (spec.corrupt === "negative") raw.prompt_tokens_details = { cached_tokens: -40 };
  }
  if (cost != null) raw.cost = cost;
  return { raw, usage: normalizeUsage(raw, format) };
}

/**
 * How much of a chunk a provider would plausibly have had cached.
 *
 * The prompt and the carried context repeat between the chunks of one chapter, so the first request
 * of a run caches nothing and writes the prefix, and later ones read it back. Deterministic given
 * the request index, so a seeded run prices the same way twice.
 */
export function cacheShapeFor(
  requestIndex: number,
  supportsCache: boolean,
): { cacheHit: number; cacheWrite: number } {
  if (!supportsCache) return { cacheHit: 0, cacheWrite: 0 };
  if (requestIndex <= 1) return { cacheHit: 0, cacheWrite: 0.34 };
  // the shared prefix is roughly the prompt plus the running context: most of it, not all
  return { cacheHit: Math.min(0.82, 0.55 + requestIndex * 0.04), cacheWrite: 0 };
}

// ---------- speech ----------
//
// The same rule one level down: a simulated speech response is built in its provider's own shape
// and read back through `normalizeSpeechUsage`, so "this provider reports nothing" and "this
// provider reports a quantity we do not bill on" are exercised by the demo rather than only by the
// tests. Three shapes, because three shapes is what the real world has:
//
//   gemini  usageMetadata.promptTokenCount, and the AUDIO slice of candidatesTokensDetails
//   fish    usage.bytes — the quantity it actually meters, whatever its price page calls it
//   none    OpenAI's speech endpoint returns audio and no usage at all

/** Which speech payload shape an endpoint answers in, chosen from the model and the host. */
export function speechUsageFormatFor(model: string, baseUrl: string): SpeechUsageFormat {
  const s = `${model} ${baseUrl}`.toLowerCase();
  if (/gemini|generativelanguage|vertex/.test(s)) return "gemini";
  if (/fish\.audio|fish-/.test(s)) return "fish";
  if (/localhost|127\.0\.0\.1/.test(s)) return "plain";
  return "none";
}

export interface SimulatedSpeechSpec {
  /** what we counted on the way out, every way it can be counted */
  units: BillableUnits;
  /** make the payload wrong or thin on purpose, for the cases that have to survive it */
  corrupt?: "no-audio-tokens" | "no-usage" | "negative";
}

export interface SimulatedSpeechResponse {
  raw: Record<string, unknown> | null;
  usage: SpeechUsage;
}

/**
 * Build a speech provider's usage payload and read it back through the normalizer.
 *
 * A provider's own tokeniser is not ours, so the counts it reports are deliberately *near* what we
 * measured rather than equal to it — which is the whole reason a reported count is preferred over a
 * measured one where it exists, and why the receipt says which of the two each line used.
 */
export function simulateSpeechUsage(
  spec: SimulatedSpeechSpec,
  format: SpeechUsageFormat,
): SimulatedSpeechResponse {
  const u = spec.units;
  if (format === "none" || spec.corrupt === "no-usage")
    return { raw: null, usage: normalizeSpeechUsage(null, format === "none" ? "none" : format) };

  let raw: Record<string, unknown>;
  if (format === "gemini") {
    // the provider's tokeniser reads the same text a few per cent differently from ours
    const promptTokens = Math.max(1, Math.round((u.textTokens ?? 0) * 1.06));
    const audioTokens = Math.max(0, Math.round(u.audioSeconds * 25));
    raw = {
      usageMetadata: {
        promptTokenCount: promptTokens,
        candidatesTokenCount: audioTokens,
        candidatesTokensDetails:
          spec.corrupt === "no-audio-tokens"
            ? []
            : [{ modality: "AUDIO", tokenCount: audioTokens }],
        totalTokenCount: promptTokens + audioTokens,
      },
    };
    if (spec.corrupt === "no-audio-tokens")
      delete (raw.usageMetadata as Record<string, unknown>).candidatesTokenCount;
    if (spec.corrupt === "negative")
      (raw.usageMetadata as Record<string, unknown>).promptTokenCount = -promptTokens;
  } else if (format === "fish") {
    raw = { usage: { bytes: u.bytes, characters: u.chars } };
    if (spec.corrupt === "negative") raw = { usage: { bytes: -u.bytes } };
  } else {
    raw = { characters: u.chars, audio_seconds: Number(u.audioSeconds.toFixed(3)) };
    if (spec.corrupt === "negative") raw = { characters: -u.chars };
  }
  return { raw, usage: normalizeSpeechUsage(raw, format) };
}
