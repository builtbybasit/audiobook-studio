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
  TtsBillingUnit,
  WaitReason,
} from "@/types";
import { profileErrors } from "@/lib/scripting";
import { keyring } from "@/lib/keyring";

/** The app's own text→audio model, used to convert between characters and audio minutes:
 *  a clip is `words / 2.6` seconds long and a word is ~5.5 characters. */
export const AUDIO_CHARS_PER_SECOND = 5.5 * 2.6;
/** Rough tokeniser ratio, the same one `tokenEstimate` uses. */
export const CHARS_PER_TOKEN = 4;

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
      billing: { unit: "chars", rate: 0 },
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
      "Same endpoint and request shape as the free tier with a different `model` header. Set the " +
      "rate from your Fish Audio plan — it is left unknown rather than guessed, so the estimate " +
      "says so instead of showing $0.",
    apply: {
      name: "Fish Audio",
      baseUrl: "https://api.fish.audio/v1",
      model: "s2.1-pro",
      needsKey: true,
      price: 0,
      billing: { unit: "chars", rate: null },
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

// ---------- billing ----------

export const BILLING_UNITS: { value: TtsBillingUnit; label: string; hint: string }[] = [
  { value: "chars", label: "per 1M characters", hint: "OpenAI-style character billing" },
  { value: "tokens", label: "per 1M tokens", hint: "providers that tokenise the input text" },
  { value: "minute", label: "per audio minute", hint: "billed on the length of what comes back" },
  { value: "request", label: "per request", hint: "flat fee per call, regardless of length" },
];

export const billingUnitLabel = (unit: TtsBillingUnit): string =>
  BILLING_UNITS.find((b) => b.value === unit)?.label ?? unit;

export const billingOf = (e: Endpoint): TtsBilling => e.billing ?? { unit: "chars", rate: e.price };

/** The per-1M-characters figure the run estimator works in. `null` when the endpoint's real unit
 *  can't be converted from a character count alone (per-request), or when the rate is unknown. */
export function perMillionChars(billing: TtsBilling): number | null {
  if (billing.rate == null) return null;
  switch (billing.unit) {
    case "chars":
      return billing.rate;
    case "tokens":
      return billing.rate / CHARS_PER_TOKEN;
    case "minute":
      return (billing.rate * 1e6) / (AUDIO_CHARS_PER_SECOND * 60);
    case "request":
      return null;
  }
}

/** What one TTS request costs, given what it actually sent and got back. `null` = unknown. */
export function ttsCost(billing: TtsBilling, chars: number, audioSeconds: number): number | null {
  if (billing.rate == null) return null;
  switch (billing.unit) {
    case "chars":
      return (chars / 1e6) * billing.rate;
    case "tokens":
      return (chars / CHARS_PER_TOKEN / 1e6) * billing.rate;
    case "minute":
      return (audioSeconds / 60) * billing.rate;
    case "request":
      return billing.rate;
  }
}

// ---------- money ----------

/** Money to a sensible number of places: cents for real sums, more for fractions of a cent. */
export function money(n: number): string {
  const abs = Math.abs(n);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  return (
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })
  );
}

/** An unknown cost is never $0. */
export const maybeMoney = (n: number | null | undefined): string =>
  n == null ? "unknown" : money(n);

export const rate = (n: number | null): string => (n == null ? "unknown" : money(n));

/** The one-line pricing shown on a card. */
export function pricingLabel(u: UnifiedEndpoint): string {
  if (u.profile) {
    const { inPrice, outPrice } = u.profile;
    if (!inPrice && !outPrice) return "no rates entered";
    return `${money(inPrice)} in / ${money(outPrice)} out · 1M tokens`;
  }
  const b = billingOf(u.endpoint!);
  if (b.rate == null) return "rate not known";
  if (b.rate === 0) return "no charge";
  return `${money(b.rate)} ${billingUnitLabel(b.unit)}`;
}

/** True when we cannot price this endpoint's requests at all. */
export const unpriced = (u: UnifiedEndpoint): boolean =>
  u.endpoint ? billingOf(u.endpoint).rate == null : false;

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
