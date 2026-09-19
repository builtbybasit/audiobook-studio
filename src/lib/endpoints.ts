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
  Gender,
  MetricTotals,
  Profile,
  TtsBilling,
  Voice,
  WaitReason,
} from "@/types";
import { profileErrors } from "@/lib/scripting";
import { keyring } from "@/lib/keyring";
import {
  baseRates,
  billingProblems,
  effectiveRates,
  ensurePricing,
  pricingOneLiner,
  pricingProblems,
  speechPricingOf,
  speechRateKnown,
} from "@/lib/pricing";

export const OPS_DEFAULTS: Record<EndpointKind, EndpointOps> = {
  scripting: {
    timeoutSec: 120,
    maxRetries: 3,
    cooldownSec: 10,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
  },
  tts: {
    timeoutSec: 60,
    maxRetries: 2,
    cooldownSec: 8,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
  },
};

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

/** What each kind appends to the base URL — worth showing, since the two differ. */
export const KIND_PATH: Record<EndpointKind, string> = {
  scripting: "/chat/completions",
  tts: "/audio/speech",
};

// ---------- presets ----------

/** What a provider's "add this endpoint" form should be filled in with. Everything here is a
 *  starting point the user can still edit; only fields a provider genuinely pins down are set.
 *  The app never calls a provider, so these are documentation as much as defaults. */
export interface TtsPreset {
  id: string;
  label: string;
  hint: string;
  /** shown under the picker once chosen — the caveat that belongs with this choice */
  note?: string;
  apply: Partial<Endpoint>;
}

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

export const presetById = (id: string): TtsPreset | undefined =>
  TTS_PRESETS.find((p) => p.id === id);

/** Fish Audio takes the model in a header and the voice as `reference_id`, so the path everything
 *  else uses does not apply. Kept here so the Connection tab can show the right request line. */
export const isFishAudio = (e: Pick<Endpoint, "baseUrl">): boolean =>
  /(^|\/\/)([a-z0-9-]+\.)*fish\.audio(\/|$)/i.test(e.baseUrl);

export function ttsRequestPath(e: Pick<Endpoint, "baseUrl">): string {
  return isFishAudio(e) ? "/tts" : KIND_PATH.tts;
}

/** One entry of Fish Audio's `GET /model` response. Only the fields a voice list needs are typed;
 *  the real payload also carries covers, samples, like counts and the author's profile. */
export interface FishModel {
  _id: string;
  title: string;
  type?: string;
  state?: string;
  tags?: string[];
  languages?: string[];
  visibility?: string;
}

/** Fish Audio serves speech under /v1 but its model catalogue at the host root, so the voice list
 *  cannot just be appended to the base URL the way an OpenAI-compatible /audio/voices can. */
export function fishModelsUrl(baseUrl: string): string {
  return (
    baseUrl
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/v\d+$/, "") + "/model?self=true&page_size=100"
  );
}

/** Fish has no gender field — a voice carries free-form tags, and only some of them say. */
function fishGender(tags: string[] = []): Gender {
  const t = tags.map((x) => x.toLowerCase());
  if (t.includes("male") || t.includes("man") || t.includes("boy")) return "m";
  if (t.includes("female") || t.includes("woman") || t.includes("girl")) return "f";
  return "?";
}

/** A Fish voice's id *is* the `reference_id` a TTS request quotes, so the `_id` is what to keep.
 *  Anything still training, or a voice-conversion model, cannot narrate a line and is dropped. */
export function voicesFromFishModels(items: FishModel[]): Voice[] {
  return items
    .filter((m) => m._id && (m.type ?? "tts") === "tts" && (m.state ?? "trained") === "trained")
    .map((m) => ({
      id: m._id,
      label: m.title?.trim() || m._id,
      gender: fishGender(m.tags),
    }));
}

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
