// One shape for the three endpoint lists (`profiles`, `endpoints`, `transcribers`). Ids are only
// unique within a kind, so everything is keyed `<kind>:<id>`. Branch on `kind` exhaustively, never
// on which object is set, so a new kind fails to compile.
import type {
  Endpoint,
  EndpointKind,
  EndpointOps,
  MetricTotals,
  PricingConfig,
  Profile,
  RateComponent,
  RateSet,
  Transcriber,
  TtsBilling,
  TtsBillingUnit,
  VoiceRef,
  WaitReason,
} from "@/types";
import { profileErrors } from "@/lib/scripting";
import { KIND_PATH, OPS_DEFAULTS, encodingProblems } from "@/lib/endpointShapes";
import { isSimulated } from "@/lib/providers";
import {
  billingProblems,
  effectiveRates,
  ensurePricing,
  pricingOneLiner,
  pricingOf,
  pricingProblems,
  speechComponents,
  speechPricingOf,
  speechRateKnown,
  TOKEN_COMPONENTS,
} from "@/lib/pricing";

export {
  KIND_PATH,
  fishModelsUrl,
  isFishAudio,
  ttsRequestPath,
  voicesFromFishModels,
} from "@/lib/endpointShapes";

/** Fill in operational defaults in place; only absent fields are written. */
export function ensureOps<T extends Profile | Endpoint | Transcriber>(
  ep: T,
  kind: EndpointKind,
): T {
  const defaults = OPS_DEFAULTS[kind] as unknown as Record<string, unknown>;
  const target = ep as unknown as Record<string, unknown>;
  for (const k of Object.keys(defaults)) if (target[k] === undefined) target[k] = defaults[k];
  return ep;
}

export interface UnifiedEndpoint {
  /** `<kind>:<id>` */
  key: string;
  id: string;
  kind: EndpointKind;
  name: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  needsKey: boolean;
  concurrency: number;
  backoffUntil: number;
  entry: Profile | Endpoint | Transcriber;
  /** exactly one of these is set, the one `kind` names; the tabs edit it directly */
  profile: Profile | null;
  endpoint: Endpoint | null;
  transcriber: Transcriber | null;
}

const unified = (
  kind: EndpointKind,
  e: Profile | Endpoint | Transcriber,
  backoffUntil: number,
): UnifiedEndpoint => ({
  key: `${kind}:${e.id}`,
  id: e.id,
  kind,
  name: e.name,
  model: e.model,
  baseUrl: e.baseUrl,
  enabled: e.enabled,
  needsKey: e.needsKey,
  concurrency: e.concurrency,
  backoffUntil,
  entry: e,
  profile: null,
  endpoint: null,
  transcriber: null,
});

export const unifyProfile = (p: Profile): UnifiedEndpoint => ({
  ...unified("scripting", p, 0),
  profile: p,
});

export const unifyEndpoint = (e: Endpoint): UnifiedEndpoint => ({
  ...unified("tts", e, e.backoffUntil),
  endpoint: e,
});

/** No cooldown: nothing reports a transcriber's rate limits back. */
export const unifyTranscriber = (t: Transcriber): UnifiedEndpoint => ({
  ...unified("transcription", t, 0),
  transcriber: t,
});

export const unifiedOf = (lists: {
  profiles: Profile[];
  endpoints: Endpoint[];
  transcribers: Transcriber[];
}): UnifiedEndpoint[] => [
  ...lists.profiles.map(unifyProfile),
  ...lists.endpoints.map(unifyEndpoint),
  ...lists.transcribers.map(unifyTranscriber),
];

export const voiceRef = (epId: string, voiceId: string): VoiceRef => `${epId}/${voiceId}`;

export const opsOf = (u: UnifiedEndpoint): EndpointOps =>
  ({ ...OPS_DEFAULTS[u.kind], ...u.entry }) as EndpointOps;

export const KIND_LABEL: Record<EndpointKind, string> = {
  scripting: "Scripting",
  tts: "Text to speech",
  transcription: "Speech to text",
};

// ---------- presets ----------
export {
  SCRIPTING_PRESETS,
  TRANSCRIPTION_PRESETS,
  TTS_PRESETS,
  presetById,
  presetsOf,
  scriptingPresetById,
  transcriptionPresetById,
  type AnyPreset,
  type ScriptingPreset,
  type TranscriptionPreset,
  type TtsPreset,
} from "@/lib/presets";

// ---------- billing ----------
// Pricing arithmetic lives in `lib/pricing/`; this only adapts an `Endpoint` onto it.

/** An endpoint without `billing` has a per-1M-characters `price`. */
export const billingOf = (e: Endpoint): TtsBilling => e.billing ?? { unit: "chars", rate: e.price };

export const speechPricing = (e: Endpoint) => speechPricingOf({ ...e, billing: billingOf(e) });

/** Per minute of audio *sent*. */
export const transcriberBilling = (t: Transcriber): TtsBilling => ({
  unit: "minute",
  rate: t.perMinute,
});

export const transcriberPricing = (t: Transcriber) =>
  speechPricingOf({ billing: transcriberBilling(t), pricing: t.pricing });

export function rateCardOf(u: UnifiedEndpoint): {
  base: RateSet;
  config: PricingConfig;
  components: RateComponent[];
  unit?: TtsBillingUnit;
} {
  switch (u.kind) {
    case "scripting":
      return { ...pricingOf(u.profile!), components: TOKEN_COMPONENTS };
    case "tts": {
      const card = speechPricing(u.endpoint!);
      return { ...card, components: speechComponents(card.unit) };
    }
    case "transcription": {
      const card = transcriberPricing(u.transcriber!);
      return { ...card, components: speechComponents(card.unit) };
    }
  }
}

// ---------- money ----------

/** At the rates in force now, not the base card. */
export function pricingLabel(u: UnifiedEndpoint, now: number = Date.now()): string {
  const { base, config, unit } = rateCardOf(u);
  const line = pricingOneLiner(effectiveRates(base, config, now), unit);
  // the speech wording is of audio that came back; a transcriber is charged for the audio it is sent
  return u.kind === "transcription"
    ? line.replace("per audio minute", "per audio minute sent")
    : line;
}

/** A two-rate endpoint with one rate missing prices nothing, not half of each request. */
export function unpriced(u: UnifiedEndpoint): boolean {
  switch (u.kind) {
    case "tts":
      return !speechRateKnown(billingOf(u.endpoint!));
    // a profile always has its two numbers and a transcriber its one, zero being free
    case "scripting":
    case "transcription":
      return false;
  }
}

// ---------- readiness ----------

/**
 * Whether an endpoint can send a request now, else the first thing in the way, from config alone.
 * Paused holds work; a missing key fails it; cooldown is the post-429 hold until `backoffUntil`.
 * The one "can this render" check every page uses.
 */
export type Readiness =
  | { state: "ready" }
  | { state: "paused" }
  | { state: "nokey" }
  | { state: "novoices" }
  | { state: "cooldown"; seconds: number };

export function speechReadiness(e: Endpoint | Profile | Transcriber, now: number): Readiness {
  if (!e.enabled) return { state: "paused" };
  if (e.needsKey && !e.hasKey) return { state: "nokey" };
  const seconds = "backoffUntil" in e ? Math.ceil((e.backoffUntil - now) / 1000) : 0;
  if (seconds > 0) return { state: "cooldown", seconds };
  if ("voices" in e && !e.voices.length) return { state: "novoices" };
  return { state: "ready" };
}

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
  /** what was observed, and what to do about it */
  detail: string;
}

export interface HealthInput {
  hasKey: boolean;
  errors: string[];
  now: number;
  /** for the selected range; null while loading */
  totals: MetricTotals | null;
  lastSeen: number | null;
  /** a connection test has been run at least once */
  tested: boolean;
}

const NO_KEY: Record<EndpointKind, string> = {
  scripting: "This endpoint requires a key. Runs can’t start on it until one is set.",
  tts: "This endpoint requires a key. Lines routed here fail until one is set.",
  transcription: "This endpoint requires a key. Recordings sent here fail until one is set.",
};

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

/** An endpoint that has done nothing is never healthy: "Not tested", or "No recent activity". */
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
  if (u.needsKey && !input.hasKey) return mk("nokey", "Key needed", NO_KEY[u.kind]);
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

/** Readable from 0.045 to 12k; `compact` alone rounds the small end to "0". */
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

const THROUGHPUT_UNIT: Record<EndpointKind, string> = {
  scripting: "tokens/min",
  tts: "audio min/min",
  transcription: "audio min/min",
};
export const throughputUnit = (kind: EndpointKind): string => THROUGHPUT_UNIT[kind];

const THROUGHPUT_LABEL: Record<EndpointKind, string> = {
  scripting: "Tokens per minute",
  tts: "Generated audio minutes per minute",
  transcription: "Audio minutes heard per minute",
};
export const throughputLabel = (kind: EndpointKind): string => THROUGHPUT_LABEL[kind];

export function endpointErrors(u: UnifiedEndpoint): string[] {
  switch (u.kind) {
    case "scripting":
      return profileErrors(u.profile!);
    case "tts":
      return speechEndpointErrors(u.endpoint!);
    case "transcription":
      return transcriberErrors(u.transcriber!);
  }
}

/** `kind` says which path must not already be on the base URL. */
function connectionErrors(
  e: Pick<Endpoint, "baseUrl" | "name" | "model" | "concurrency">,
  kind: "tts" | "transcription",
): string[] {
  const errors: string[] = [];
  // a simulated endpoint names no host: this server answers it
  if (!isSimulated(e.baseUrl))
    try {
      const url = new URL(e.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      if (url.pathname.replace(/\/+$/, "").endsWith(KIND_PATH[kind]))
        errors.push(`Use the base URL without ${KIND_PATH[kind]}.`);
    } catch {
      errors.push("Enter a valid HTTP or HTTPS base URL.");
    }
  if (!e.name.trim()) errors.push("Give this endpoint a name.");
  if (!e.model.trim()) errors.push("Enter a model ID.");
  if (!Number.isSafeInteger(e.concurrency) || e.concurrency < 1)
    errors.push("Concurrency must be a whole number of at least 1.");
  return errors;
}

function speechEndpointErrors(e: Endpoint): string[] {
  const errors = connectionErrors(e, "tts");
  if (!Number.isSafeInteger(e.maxChars) || e.maxChars < 0)
    errors.push("Maximum characters must be zero or a positive whole number.");
  if (!e.voices.length) errors.push("No voices yet — fetch or add one before this can render.");
  errors.push(...pricingProblems(ensurePricing(e)));
  errors.push(...billingProblems(billingOf(e)));
  // the server refuses a format, bitrate and rate that cannot be asked for together
  errors.push(...encodingProblems(e).map((p) => p + "."));
  return errors;
}

export function transcriberErrors(t: Transcriber): string[] {
  const errors = connectionErrors(t, "transcription");
  if (!Number.isFinite(t.perMinute) || t.perMinute < 0)
    errors.push("The rate per audio minute must be zero or more.");
  const lambda = t.hotwordLambda;
  if (lambda != null && !(lambda >= 0 && lambda <= 100))
    errors.push("The hotword strength must be from 0 to 100.");
  errors.push(...pricingProblems(ensurePricing(t)));
  return errors;
}

/** Redact anything that looks like a credential before an error body is shown or copied. */
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
