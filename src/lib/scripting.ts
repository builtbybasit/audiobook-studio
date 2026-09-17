import type { Profile } from "@/types";
import { splitText } from "@/lib/split";
import {
  baseRates,
  dearestInput,
  effectiveRates,
  ensurePricing,
  newPricing,
  pricingProblems,
} from "@/lib/pricing";

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
        ].includes(key),
      ),
    ),
  };
  // a profile handed a partial `pricing` (an imported settings file, a fixture) gets the rest
  ensurePricing(profile);
  return profile;
}
export function profileErrors(p: Profile): string[] {
  const errors: string[] = [];
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
  return errors;
}
// Keep original whitespace: the generic preview splitter trims its displayed pieces.
export function scriptParts(text: string, p: Profile): string[] {
  if (profileErrors(p).length) return [];
  return splitText(text, p.maxChars, p.splitAt, true)
    .map((cut) => cut.text)
    .filter(Boolean);
}
/**
 * How many tokens one chunk is expected to use, and what that costs at an explicit instant.
 *
 * Two figures matter and they are deliberately different. `cost` is what this chunk would cost at
 * the rates in force *now*, including any off-peak window or promotion. `reserve` is what is held
 * against the budget while it is in flight, and it is worked out at the **undiscounted** rates with
 * the whole output ceiling: a budget must survive a promotion expiring or an off-peak window
 * closing mid-run, so a reservation is never allowed to lean on a discount that may be gone by the
 * time the request is actually sent. No cache saving is assumed either way — cache use is not
 * knowable before the answer comes back.
 *
 * The input side of the reservation is taken at the **dearest** rate any input token could be
 * charged at, not at the ordinary input rate. Cached and cache-write tokens are slices of the
 * input, and a cache write commonly costs more than ordinary input — this app defaults a new one to
 * 125% of it — so reserving the whole input at the ordinary rate lets the very first request cost
 * more than it reserved and step past the cap.
 */
export function tokenEstimate(text: string, p: Profile, at: number = Date.now()) {
  const inputTokens = Math.ceil((text.length / 4) * 1.6) + 500;
  const outputTokens = Math.ceil((text.length / 4) * 1.15);
  // a scripting profile always has both token rates; the shared card is nullable because a speech
  // card leaves them empty, so they are read back through the profile's own numbers
  const base = baseRates(p);
  const now = effectiveRates(base, ensurePricing(p), at).components;
  const inRate = now.input.rate ?? p.inPrice;
  const outRate = now.output.rate ?? p.outPrice;
  const reserveIn = dearestInput(base) ?? p.inPrice;
  return {
    inputTokens,
    outputTokens,
    inputCost: (inputTokens * inRate) / 1e6,
    outputCost: (outputTokens * outRate) / 1e6,
    cost: (inputTokens * inRate + outputTokens * outRate) / 1e6,
    reserve: (inputTokens * reserveIn + p.maxOutputTokens * p.outPrice) / 1e6,
  };
}

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
