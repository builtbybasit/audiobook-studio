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
import {
  baseRates,
  ceilingRates,
  dearestInput,
  effectiveRates,
  ensurePricing,
  newPricing,
  pricingProblems,
} from "@/lib/pricing";

/**
 * The reasoning levels a scripting endpoint can be set to, for its select. The model's own default
 * is the select's empty choice (null), which sends nothing; how each level is spelled for a host is
 * `reasoningRequest`'s.
 */
export const REASONING_LEVELS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "answers straight away" },
  { value: "low", label: "Low", hint: "a little thought" },
  { value: "medium", label: "Medium", hint: "" },
  { value: "high", label: "High", hint: "slowest, most output tokens" },
];

/**
 * The settings a run starts from, until somebody picks otherwise. No profile is chosen: a run then
 * goes to the first one that can take it (`scripting.runProfile`), and the server keeps whatever is
 * picked under the `script` settings key.
 */
export const makeScriptSettings = (): ScriptSettings => ({ profile: null });

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
    maxChars: 6000,
    splitAt: "sentence",
    maxOutputTokens: 4096,
    secPerChunk: 10,
    timeoutSec: 120,
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
  // a profile handed a partial `pricing` (an imported settings file, a fixture) gets the rest
  ensurePricing(profile);
  // …and one handed a prompt written before notes gets it as it is kept now
  if (profile.prompt != null)
    profile.prompt = upgradeProfilePrompt(profile.prompt) as Profile["prompt"];
  return profile;
}

/**
 * An endpoint's prompt as it is kept now, from one written before `{{endpoint.notes}}`: an
 * `append` — the old way a model's quirks got in — becomes Default with its texts as the notes,
 * and one without notes has none. Anything else is handed back for `profileErrors` to judge.
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
  // a simulated profile names no host — this server answers it — so it has no URL to check
  if (!isSimulated(String(p.baseUrl)))
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
  if (!["sentence", "clause", "word", "char"].includes(p.splitAt))
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
  // held to the rules of what it is used as: a Default endpoint's kept text only to its length,
  // its notes always
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

/** The tokens an answer spends besides its lines: a few speakers' notes and a recap. */
const ANSWER_EXTRAS = 150;

/**
 * How many tokens one chunk is expected to use, and what that costs at an explicit instant.
 *
 * The input is the chunk and the prompt around it. Given the template a run would send
 * (`opts.prompt`), the prompt's share is what `promptOverhead` measures it at, a character count
 * taken as tokens four to one; without one it is the flat 500 tokens the estimate used before the
 * prompt could be edited.
 *
 * The output is the script, the cast notes and recap beside it (`ANSWER_EXTRAS`), and for a model
 * that reasons, the thinking it bills as output too:
 * `opts.reasoningPerInputToken` is what the endpoint's recent requests at its current reasoning
 * level thought per input token (`ScriptEndpointTelemetry.reasoning`), and adds that share of this
 * chunk's input. Without it nothing is added — a level nobody has measured yet is not guessed at.
 *
 * Two figures matter and they are deliberately different. `cost` is what this chunk would cost at
 * the rates in force *now*, including any off-peak window or promotion. `reserve` is what is held
 * against the budget while it is in flight, and it is worked out at the **dearest** rates the card
 * can reach (`ceilingRates`) with the whole output ceiling, so the reasoning share moves the
 * estimate but never the reservation: a budget must survive a promotion expiring or an off-peak
 * window closing mid-run, so a reservation is never allowed to lean on a discount that may be gone
 * by the time the request is actually sent.
 * The base card is not that ceiling — DeepSeek's card is its off-peak price, and its peak windows
 * double it. No cache saving is assumed either way — cache use is not knowable before the answer
 * comes back.
 *
 * The input side of the reservation is taken at the **dearest** rate any input token could be
 * charged at, not at the ordinary input rate. Cached and cache-write tokens are slices of the
 * input, and a cache write commonly costs more than ordinary input — this app defaults a new one to
 * 125% of it — so reserving the whole input at the ordinary rate lets the very first request cost
 * more than it reserved and step past the cap.
 */
export function tokenEstimate(
  text: string,
  p: Profile,
  at: number = Date.now(),
  opts: { prompt?: PromptTemplate; reasoningPerInputToken?: number } = {},
) {
  return tokenEstimator(p, at, opts)(text);
}

/**
 * `tokenEstimate` for many chunks sent to one endpoint at one instant. The prompt's overhead and
 * the rates are the same for every chunk, and working them out — rendering the prompt, resolving
 * the pricing windows — costs far more than the chunk's own arithmetic, so they are worked out
 * once and the returned function only counts each chunk.
 */
export function tokenEstimator(
  p: Profile,
  at: number = Date.now(),
  opts: { prompt?: PromptTemplate; reasoningPerInputToken?: number } = {},
) {
  const overhead = opts.prompt ? Math.ceil(promptOverhead(opts.prompt) / 4) : 500;
  // a scripting profile always has both token rates; the shared card is nullable because a speech
  // card leaves them empty, so they are read back through the profile's own numbers
  const base = baseRates(p);
  const now = effectiveRates(base, ensurePricing(p), at).components;
  const inRate = now.input.rate ?? p.inPrice;
  const outRate = now.output.rate ?? p.outPrice;
  const ceiling = ceilingRates(base, ensurePricing(p));
  const reserveIn = dearestInput(ceiling) ?? p.inPrice;
  const reserveOut = ceiling.output ?? p.outPrice;
  return (text: string) => {
    const inputTokens = Math.ceil((text.length / 4) * 1.6) + overhead;
    /** of `outputTokens`, the thinking a reasoning model is expected to bill as output */
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

/**
 * What an endpoint's own estimate says of thinking, under its token figures: how many thinking
 * tokens a chunk is counted at (`tokenEstimate`'s `reasoningTokens`) and what that was learnt from,
 * or, with a level set that nothing has measured yet, that none is counted. Null when there is
 * nothing to say — no level asked for and nothing seen, or thinking switched off.
 */
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

/** What a profile nothing has been sent to yet has been through: nothing. */
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
