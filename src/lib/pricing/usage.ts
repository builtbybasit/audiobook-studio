// What a provider reported a request used, read into the one shape the rest of pricing works in.
//
// Nothing downstream reads a provider's payload directly, so a count a provider left out stays
// `null` — "not reported" — rather than becoming a zero on its way to a receipt.
import type {
  SpeechUsage,
  SpeechUsageFormat,
  TokenUsage,
  UsageFormat,
  UsageProblem,
} from "@/types";

// ---------- normalizing what a provider reported ----------

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** What each usage problem means, in the words a receipt shows beside the figure it undermines. */
export const USAGE_PROBLEM: Record<string, string> = {
  "cache-not-reported":
    "This provider did not report cached input, so how much of the input was cached is unknown.",
  "input-missing": "No input token count came back, so the input charge could not be worked out.",
  "output-missing": "No output token count came back.",
  "cache-exceeds-input":
    "The reported cached and cache-write tokens add up to more than the total input. The counts were clamped so no token is charged twice, and this cost should be treated as unreliable.",
  negative: "A token count came back negative. It was read as zero.",
  "usage-not-reported":
    "This provider returned no usage for the request, so the charge is worked out from what was counted on the way out rather than from anything it confirmed.",
  "billed-unit-missing":
    "The provider reported usage, but not the quantity this endpoint bills on. That quantity is the one counted here, so the charge is an estimate rather than a reconciliation.",
  "audio-tokens-estimated":
    "The provider did not report audio tokens. They were worked out from the audio's length and this endpoint's tokens-per-second setting, which is an assumption and not a measurement.",
};

/**
 * Read a provider's usage payload into the one internal shape.
 *
 * The two shapes that matter disagree about the most important thing: OpenAI's `prompt_tokens`
 * *includes* the cached tokens, Anthropic's `input_tokens` *excludes* them. Getting that backwards
 * either charges cached tokens twice or loses them, so it is the first thing this does — and
 * `inputTokens` on the way out always means the total.
 */
export function normalizeUsage(raw: Record<string, unknown>, format: UsageFormat): TokenUsage {
  const problems: UsageProblem[] = [];
  const note = (code: UsageProblem["code"], repaired?: boolean) =>
    problems.push({ code, message: USAGE_PROBLEM[code], ...(repaired ? { repaired: true } : {}) });

  let inputTotal: number | null = null;
  let cachedInput: number | null = null;
  let cacheWrite: number | null = null;
  let output: number | null = null;
  // Of the output, what was spent thinking: `completion_tokens_details.reasoning_tokens`, where
  // OpenAI, OpenRouter and DeepSeek report it. Already inside the output tokens, so it is never
  // priced on its own; it is kept for what a reasoning model's thinking adds to the next estimate.
  let reasoning: number | null = null;
  const completionDetails = raw.completion_tokens_details;
  if (format === "openai" || format === "plain")
    reasoning =
      completionDetails && typeof completionDetails === "object"
        ? num((completionDetails as Record<string, unknown>).reasoning_tokens)
        : null;
  else if (format === "internal") reasoning = num(raw.reasoningTokens);
  if (reasoning != null && reasoning < 0) reasoning = null;

  if (format === "openai") {
    const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
    inputTotal = num(raw.prompt_tokens);
    cachedInput = details ? num(details.cached_tokens) : null;
    // OpenAI reports no cache writes; OpenRouter does, as another slice of prompt_tokens
    cacheWrite = details ? num(details.cache_write_tokens) : null;
    output = num(raw.completion_tokens);
  } else if (format === "anthropic") {
    const uncached = num(raw.input_tokens);
    cachedInput = num(raw.cache_read_input_tokens);
    cacheWrite = num(raw.cache_creation_input_tokens);
    // input_tokens counts only what was *not* served from or written to the cache
    inputTotal =
      uncached == null
        ? null
        : uncached + Math.max(0, cachedInput ?? 0) + Math.max(0, cacheWrite ?? 0);
    output = num(raw.output_tokens);
  } else if (format === "plain") {
    inputTotal = num(raw.prompt_tokens) ?? num(raw.input_tokens);
    output = num(raw.completion_tokens) ?? num(raw.output_tokens);
  } else {
    inputTotal = num(raw.inputTokens);
    cachedInput = num(raw.cachedInput);
    cacheWrite = num(raw.cacheWrite);
    output = num(raw.outputTokens);
  }

  if (inputTotal == null) {
    note("input-missing");
    inputTotal = 0;
  }
  if (output == null) {
    note("output-missing");
    output = 0;
  }
  if (
    inputTotal < 0 ||
    output < 0 ||
    (cachedInput != null && cachedInput < 0) ||
    (cacheWrite != null && cacheWrite < 0)
  ) {
    note("negative", true);
    inputTotal = Math.max(0, inputTotal);
    output = Math.max(0, output);
    if (cachedInput != null) cachedInput = Math.max(0, cachedInput);
    if (cacheWrite != null) cacheWrite = Math.max(0, cacheWrite);
  }
  const parts = (cachedInput ?? 0) + (cacheWrite ?? 0);
  if (parts > inputTotal) {
    note("cache-exceeds-input", true);
    // keep the reported parts visible but never let the ordinary-input line go negative
    inputTotal = parts;
  }
  if (cachedInput == null) note("cache-not-reported");

  const reportedCost = num(raw.cost) ?? num(raw.total_cost) ?? null;
  return {
    inputTokens: inputTotal,
    cachedInput,
    cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    format,
    problems,
    ...(reportedCost != null ? { reportedCost } : {}),
  };
}

// ---------- normalizing what a speech provider reported ----------

const nothingReported = (format: SpeechUsageFormat): SpeechUsage => ({
  chars: null,
  bytes: null,
  textTokens: null,
  audioSeconds: null,
  audioTokens: null,
  format,
  problems: [{ code: "usage-not-reported", message: USAGE_PROBLEM["usage-not-reported"] }],
});

/**
 * Read a speech provider's usage payload into the one internal shape.
 *
 * The same rule as the token side and for the same reason: nothing downstream reads a provider
 * payload directly, so "the provider did not say" can never be quietly rounded to zero on its way
 * through. Each shape reports a *different* quantity — Gemini counts tokens both ways, Fish counts
 * the bytes it bills on, OpenAI's speech endpoint counts nothing at all — and the fields it did not
 * fill in stay `null`.
 */
export function normalizeSpeechUsage(
  raw: Record<string, unknown> | null | undefined,
  format: SpeechUsageFormat,
): SpeechUsage {
  if (format === "none" || !raw) return nothingReported(format);
  const problems: UsageProblem[] = [];
  let chars: number | null = null;
  let bytes: number | null = null;
  let textTokens: number | null = null;
  let audioSeconds: number | null = null;
  let audioTokens: number | null = null;

  if (format === "gemini") {
    const meta = (raw.usageMetadata ?? raw) as Record<string, unknown>;
    textTokens = num(meta.promptTokenCount);
    // The audio tokens are the AUDIO-modality slice of the response, not the whole of it: a
    // response that also carries text would otherwise have its text charged at the audio rate.
    const details = Array.isArray(meta.candidatesTokensDetails)
      ? (meta.candidatesTokensDetails as Record<string, unknown>[])
      : [];
    const audio = details.find((d) => String(d.modality).toUpperCase() === "AUDIO");
    audioTokens = audio ? num(audio.tokenCount) : num(meta.candidatesTokenCount);
  } else if (format === "fish") {
    const usage = (raw.usage ?? raw) as Record<string, unknown>;
    bytes = num(usage.bytes);
    chars = num(usage.characters) ?? num(usage.chars);
  } else if (format === "plain") {
    chars = num(raw.characters) ?? num(raw.chars);
    audioSeconds = num(raw.audio_seconds) ?? num(raw.duration);
  } else {
    chars = num(raw.chars);
    bytes = num(raw.bytes);
    textTokens = num(raw.textTokens);
    audioSeconds = num(raw.audioSeconds);
    audioTokens = num(raw.audioTokens);
  }

  const clamp = (n: number | null): number | null => {
    if (n == null) return null;
    if (n < 0) {
      if (!problems.some((p) => p.code === "negative"))
        problems.push({ code: "negative", message: USAGE_PROBLEM.negative, repaired: true });
      return 0;
    }
    return n;
  };
  chars = clamp(chars);
  bytes = clamp(bytes);
  textTokens = clamp(textTokens);
  audioSeconds = clamp(audioSeconds);
  audioTokens = clamp(audioTokens);

  if (chars == null && bytes == null && textTokens == null && audioTokens == null)
    problems.push({ code: "usage-not-reported", message: USAGE_PROBLEM["usage-not-reported"] });

  const reportedCost = num(raw.cost) ?? num(raw.total_cost) ?? null;
  return {
    chars,
    bytes,
    textTokens,
    audioSeconds,
    audioTokens,
    format,
    problems,
    ...(reportedCost != null ? { reportedCost } : {}),
  };
}

/** Input tokens charged at the ordinary rate: the total less the parts that have their own line. */
export const uncachedInput = (u: TokenUsage): number =>
  Math.max(0, u.inputTokens - (u.cachedInput ?? 0) - (u.cacheWrite ?? 0));

export const usageTrustworthy = (u: TokenUsage): boolean =>
  !u.problems.some((p) => p.code !== "cache-not-reported");
