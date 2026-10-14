import type {
  Profile,
  PromptTemplate,
  ReasoningEffort,
  ScriptEndpointTelemetry,
  ScriptSettings,
} from "@/types";
import { splitText } from "@/lib/split";
import { REASONING_EFFORTS, profilePromptProblems, promptOverhead } from "@/lib/prompt";
import { isSimulated } from "@/lib/providers";
import { cliOf } from "@/lib/providers/cli";
import {
  baseRates,
  ceilingRates,
  dearestInput,
  effectiveRates,
  ensurePricing,
  newPricing,
  pricingProblems,
} from "@/lib/pricing";

/** The model's own default is the select's empty choice (null), which sends nothing. */
export const REASONING_LEVELS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "answers straight away" },
  { value: "low", label: "Low", hint: "a little thought" },
  { value: "medium", label: "Medium", hint: "" },
  { value: "high", label: "High", hint: "slowest, most output tokens" },
];

/** No profile chosen: a run goes to the first one that can take it (`scripting.runProfile`). */
export const makeScriptSettings = (): ScriptSettings => ({ profile: null });

/**
 * About 3,300 words, so most web-novel chapters go in one request, with the answer (about as many
 * tokens again) inside the default output cap and timeout.
 */
export const DEFAULT_MAX_CHARS = 20000;

export function newProfile(p: Partial<Profile> = {}): Profile {
  const profile: Profile = {
    id: crypto.randomUUID(),
    name: "Custom endpoint",
    baseUrl: "http://localhost:8000/v1",
    model: "",
    enabled: true,
    needsKey: true,
    inPrice: 0,
    outPrice: 0,
    pricing: newPricing(),
    concurrency: 4,
    maxChars: DEFAULT_MAX_CHARS,
    // a request that opens mid-paragraph can read the paragraph's start, sent as context, as its own
    splitAt: "paragraph",
    maxOutputTokens: 16384,
    secPerChunk: 10,
    timeoutSec: 300,
    maxRetries: 3,
    cooldownSec: 10,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
    reasoning: null,
    ...Object.fromEntries(
      Object.entries(p).filter(([key]) =>
        [
          "id",
          "name",
          "baseUrl",
          "model",
          "enabled",
          "needsKey",
          "inPrice",
          "outPrice",
          "pricing",
          "concurrency",
          "maxChars",
          "splitAt",
          "maxOutputTokens",
          "secPerChunk",
          "timeoutSec",
          "maxRetries",
          "cooldownSec",
          "spendLimit",
          "credentialId",
          "quotaGroup",
          "reasoning",
          "prompt",
        ].includes(key),
      ),
    ),
  };
  // a partial `pricing` (an imported settings file, a fixture) gets the rest
  ensurePricing(profile);
  if (profile.prompt != null)
    profile.prompt = upgradeProfilePrompt(profile.prompt) as Profile["prompt"];
  return profile;
}

/**
 * Upgrades a saved prompt: an `append` becomes Default with its texts as the notes, and missing
 * notes become "". Anything else is handed back for `profileErrors` to judge.
 */
export function upgradeProfilePrompt(prompt: unknown): unknown {
  if (!prompt || typeof prompt !== "object") return prompt;
  const o = prompt as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  if (o.mode === "append")
    return {
      mode: "default",
      system: "",
      user: "",
      notes: [o.notes, o.system, o.user].map(text).filter(Boolean).join("\n\n"),
    };
  return o.notes === undefined ? { ...o, notes: "" } : o;
}
export function profileErrors(p: Profile): string[] {
  const errors: string[] = [];
  // simulated and command-line profiles name no host
  if (!isSimulated(String(p.baseUrl)) && !cliOf(String(p.baseUrl)))
    try {
      const url = new URL(p.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      if (/\/chat\/completions\/?$/.test(url.pathname))
        errors.push("Use the base URL without /chat/completions.");
    } catch {
      errors.push("Enter a valid HTTP or HTTPS base URL.");
    }
  if (typeof p.name !== "string" || !p.name.trim()) errors.push("Give this endpoint a name.");
  if (typeof p.model !== "string" || !p.model.trim()) errors.push("Enter a model ID.");
  for (const [label, value, min] of [
    ["Concurrency", p.concurrency, 1],
    ["Max characters", p.maxChars, 0],
    ["Max output tokens", p.maxOutputTokens, 1],
  ] as const)
    if (!Number.isSafeInteger(value) || value < min)
      errors.push(`${label} must be a whole number of at least ${min}.`);
  if (![p.inPrice, p.outPrice].every((v) => Number.isFinite(v) && v >= 0))
    errors.push("Token prices must be zero or greater.");
  if (!["paragraph", "sentence", "clause", "word", "char"].includes(p.splitAt))
    errors.push("Choose a valid cut boundary.");
  if (
    typeof p.id !== "string" ||
    !p.id ||
    typeof p.enabled !== "boolean" ||
    typeof p.needsKey !== "boolean"
  )
    errors.push("Invalid endpoint identity or enabled/key setting.");
  if (!Number.isFinite(p.secPerChunk) || p.secPerChunk <= 0)
    errors.push("Request duration must be greater than zero.");
  if (p.pricing) errors.push(...pricingProblems(p.pricing));
  if (p.reasoning != null && !REASONING_EFFORTS.includes(p.reasoning))
    errors.push("Choose a valid reasoning level.");
  const prompt = p.prompt;
  if (
    prompt != null &&
    (typeof prompt !== "object" ||
      !["default", "replace"].includes(prompt.mode) ||
      typeof prompt.system !== "string" ||
      typeof prompt.user !== "string" ||
      typeof prompt.notes !== "string")
  )
    errors.push("Invalid prompt settings.");
  else if (prompt)
    for (const problem of profilePromptProblems(prompt)) errors.push(`Prompt: ${problem}`);
  return errors;
}
// Keep original whitespace: the generic preview splitter trims its displayed pieces.
export function scriptParts(text: string, p: Profile): string[] {
  if (profileErrors(p).length) return [];
  return splitText(text, p.maxChars, p.splitAt, true)
    .map((cut) => cut.text)
    .filter(Boolean);
}

/** Answer tokens besides the lines: cast notes and a recap. */
const ANSWER_EXTRAS = 150;

/**
 * Tokens one chunk is expected to use, and their cost at `at`. Thinking is added only from measured
 * `opts.reasoningPerInputToken`, never guessed. `cost` uses the rates in force now; `reserve` uses
 * the dearest the card can reach (`ceilingRates`, `dearestInput`) with the whole output ceiling, so
 * a budget survives a promotion ending mid-run. No cache saving is assumed.
 */
export function tokenEstimate(
  text: string,
  p: Profile,
  at: number = Date.now(),
  opts: { prompt?: PromptTemplate; reasoningPerInputToken?: number } = {},
) {
  return tokenEstimator(p, at, opts)(text);
}

/** `tokenEstimate` for many chunks: the prompt overhead and rates are worked out once. */
export function tokenEstimator(
  p: Profile,
  at: number = Date.now(),
  opts: { prompt?: PromptTemplate; reasoningPerInputToken?: number } = {},
) {
  const overhead = opts.prompt ? Math.ceil(promptOverhead(opts.prompt) / 4) : 500;
  // the shared card is nullable (speech leaves token rates empty); a profile always has both
  const base = baseRates(p);
  const now = effectiveRates(base, ensurePricing(p), at).components;
  const inRate = now.input.rate ?? p.inPrice;
  const outRate = now.output.rate ?? p.outPrice;
  const ceiling = ceilingRates(base, ensurePricing(p));
  const reserveIn = dearestInput(ceiling) ?? p.inPrice;
  const reserveOut = ceiling.output ?? p.outPrice;
  return (text: string) => {
    const inputTokens = Math.ceil((text.length / 4) * 1.6) + overhead;
    /** of `outputTokens`, the expected thinking */
    const reasoningTokens = Math.ceil(inputTokens * (opts.reasoningPerInputToken ?? 0));
    const outputTokens = Math.ceil((text.length / 4) * 1.15) + ANSWER_EXTRAS + reasoningTokens;
    return {
      inputTokens,
      outputTokens,
      reasoningTokens,
      inputCost: (inputTokens * inRate) / 1e6,
      outputCost: (outputTokens * outRate) / 1e6,
      cost: (inputTokens * inRate + outputTokens * outRate) / 1e6,
      reserve: (inputTokens * reserveIn + p.maxOutputTokens * reserveOut) / 1e6,
    };
  };
}

/** The note under an estimate about counted thinking tokens; null when there is nothing to say. */
export function reasoningEstimateNote(
  level: ReasoningEffort | null | undefined,
  seen: ScriptEndpointTelemetry["reasoning"],
  thinkingTokens: number,
): string | null {
  if (seen) {
    const from = `from the last ${seen.requests === 1 ? "request" : `${seen.requests.toLocaleString("en")} requests`} at this level`;
    return thinkingTokens > 0
      ? `incl. ~${thinkingTokens.toLocaleString("en")} thinking tokens a chunk, ${from}`
      : `no thinking tokens counted, ${from}`;
  }
  if (level && level !== "off")
    return "Thinking isn’t counted yet — no request at this level has reported it.";
  return null;
}

export const unusedTelemetry = (): ScriptEndpointTelemetry => ({
  completed: 0,
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
  lastSuccess: 0,
  history: [],
});

export function scriptingHealth(
  p: Profile,
  telemetry: import("@/types").ScriptEndpointTelemetry | undefined,
  hasKey: boolean,
  now: number,
) {
  if (!p.enabled) return { label: "Paused", tone: "muted" };
  if (profileErrors(p).length) return { label: "Check settings", tone: "warn" };
  if (p.needsKey && !hasKey) return { label: "Key needed", tone: "warn" };
  if (telemetry && telemetry.backoffUntil > now)
    return { label: `Retry in ${Math.ceil((telemetry.backoffUntil - now) / 1000)}s`, tone: "warn" };
  if (telemetry?.lastError && telemetry.lastSuccess <= telemetry.lastError.at)
    return { label: "Awaiting retry", tone: "warn" };
  if (telemetry?.completed)
    return { label: telemetry.lastError ? "Recovered" : "Healthy", tone: "good" };
  return { label: "Not used yet", tone: "muted" };
}
