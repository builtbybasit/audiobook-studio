// Endpoints and scripting profiles, between rows and the shapes the app configures.
// Configuration is stored; telemetry (`ENDPOINT_TELEMETRY`) is not, and reads back empty: the
// `requests` ledger is the durable record, and a persisted backoff would outlive its rate limit.
import type {
  Endpoint,
  EndpointOps,
  ExpressionConfig,
  ExpressionTag,
  LocalServer,
  PricingConfig,
  Profile,
  ProfilePrompt,
  Promotion,
  RateWindow,
  SpeedRange,
  Transcriber,
  TtsBilling,
  Voice,
} from "@/types";
import type { StoredEndpoint } from "@/lib/endpointTelemetry";
import { withBrackets } from "@/lib/expressions";
import type { endpoints, expressionTags, promotions, rateWindows, voices } from "~/db/schema";

type EndpointRow = typeof endpoints.$inferSelect;
type VoiceRow = typeof voices.$inferSelect;
type WindowRow = typeof rateWindows.$inferSelect;
type PromotionRow = typeof promotions.$inferSelect;
type TagRow = typeof expressionTags.$inferSelect;

/** Everything an endpoint owns besides its own row. */
export interface EndpointParts {
  voices: readonly VoiceRow[];
  windows: readonly WindowRow[];
  promotions: readonly PromotionRow[];
  tags: readonly TagRow[];
}

const byPosition = <T extends { position: number }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.position - b.position);

export const toVoice = (row: VoiceRow): Voice => ({
  id: row.id,
  gender: row.gender,
  label: row.label,
  ...(row.speed != null ? { speed: row.speed } : {}),
  ...(row.profile != null ? { profile: row.profile } : {}),
});

export function toRateWindow(row: WindowRow): RateWindow {
  const w: RateWindow = {
    id: row.id,
    label: row.label,
    days: row.days,
    from: row.fromMinute,
    to: row.toMinute,
  };
  if (row.percent != null) w.percent = row.percent;
  if (row.rates != null) w.rates = row.rates;
  return w;
}

export function toPromotion(row: PromotionRow): Promotion {
  const p: Promotion = {
    id: row.id,
    label: row.label,
    from: row.fromAt,
    until: row.untilAt,
    scope: row.scope,
  };
  if (row.percent != null) p.percent = row.percent;
  if (row.rates != null) p.rates = row.rates;
  if (row.note != null) p.note = row.note;
  return p;
}

export const toExpressionTag = (row: TagRow): ExpressionTag => ({
  id: row.id,
  label: row.label,
  token: row.token,
  kind: row.kind,
});

/** Undefined when never configured. */
function toPricingConfig(row: EndpointRow, parts: EndpointParts): PricingConfig | undefined {
  if (row.timezone == null) return undefined;
  return {
    cachedInput: row.cachedInput,
    cacheWrite: row.cacheWrite,
    timezone: row.timezone,
    windows: byPosition(parts.windows).map(toRateWindow),
    promotions: byPosition(parts.promotions).map(toPromotion),
  };
}

function toBilling(row: EndpointRow): TtsBilling | undefined {
  if (!row.billingUnit) return undefined;
  const b: TtsBilling = { unit: row.billingUnit, rate: row.billingRate };
  if (row.billingAudioRate != null) b.audioRate = row.billingAudioRate;
  if (row.audioTokensPerSecond != null) b.audioTokensPerSecond = row.audioTokensPerSecond;
  if (row.billsInstructions != null) b.billsInstructions = row.billsInstructions;
  if (row.parkedRates != null) b.parked = row.parkedRates;
  return b;
}

function toExpressions(row: EndpointRow, parts: EndpointParts): ExpressionConfig | undefined {
  if (!row.expressionStatus) return undefined;
  return withBrackets({
    status: row.expressionStatus,
    model: row.expressionModel ?? "",
    baseUrl: row.expressionBaseUrl ?? "",
    brackets: row.expressionBrackets ?? undefined,
    open: row.expressionOpen ?? undefined,
    tags: byPosition(parts.tags).map(toExpressionTag),
  });
}

/**
 * The operational settings both kinds share, all six or none; `timeoutSec` marks the block. Inside
 * it a null is a setting (`spendLimit: null` = no limit) and is kept; outside it, null means unset.
 */
function ops(row: EndpointRow): Partial<Endpoint> {
  if (row.timeoutSec == null)
    return {
      ...(row.spendLimit != null ? { spendLimit: row.spendLimit } : {}),
      ...(row.credentialId != null ? { credentialId: row.credentialId } : {}),
      ...(row.quotaGroup != null ? { quotaGroup: row.quotaGroup } : {}),
    };
  return {
    timeoutSec: row.timeoutSec,
    maxRetries: row.maxRetries ?? 0,
    cooldownSec: row.cooldownSec ?? 0,
    spendLimit: row.spendLimit,
    credentialId: row.credentialId,
    quotaGroup: row.quotaGroup,
  };
}

/** A speech endpoint; telemetry comes back empty (see the top of this file). */
export function toEndpoint(row: EndpointRow, parts: EndpointParts): Endpoint {
  const e: Endpoint = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    concurrency: row.concurrency,
    enabled: row.enabled,
    latency: row.latency ?? 0,
    failRate: row.failRate ?? 0,
    price: row.price ?? 0,
    needsKey: row.needsKey,
    maxChars: row.maxChars,
    splitAt: row.splitAt,
    voices: byPosition(parts.voices).map(toVoice),
    history: [],
    failures: 0,
    rateLimits: 0,
    backoffUntil: 0,
    ...ops(row),
  };
  const pricing = toPricingConfig(row, parts);
  if (pricing) e.pricing = pricing;
  const billing = toBilling(row);
  if (billing) e.billing = billing;
  const expressions = toExpressions(row, parts);
  if (expressions) e.expressions = expressions;
  if (row.sampleRate != null) e.sampleRate = row.sampleRate;
  if (!row.batch) e.batch = false;
  if (row.makesVoices) e.makesVoices = true;
  if (row.server) e.server = row.server;
  if (row.speedRange) e.speedRange = row.speedRange;
  if (row.launch) e.launch = row.launch;
  if (row.audioFormat != null)
    e.encoding = {
      format: row.audioFormat,
      ...(row.audioBitrate != null ? { bitrate: row.audioBitrate } : {}),
    };
  // whether there is a key, and never the key: `api_key` is write-only over HTTP
  if (row.apiKey) e.hasKey = true;
  return e;
}

/**
 * Row-id prefix for scripting profiles: the kinds share a table but not a namespace. A speech
 * endpoint keeps its bare id, since a voice names it as `<endpointId>/<voiceId>`.
 */
export const PROFILE_KEY = "scripting:";
export const profileKey = (id: string): string => PROFILE_KEY + id;

/** See `PROFILE_KEY`. */
export const TRANSCRIBER_KEY = "transcription:";
export const transcriberKey = (id: string): string => TRANSCRIBER_KEY + id;

/**
 * A profile's prompt, or undefined when none of its four columns is set; a null mode reads as
 * `default`. A legacy `append` mode reads as `default` with its text moved into the notes.
 */
function toProfilePrompt(row: EndpointRow): ProfilePrompt | undefined {
  const { promptSystem, promptUser, promptNotes } = row;
  // typed as the modes it should hold; read as the text it may hold
  const promptMode: string | null = row.promptMode;
  if (promptMode == null && promptSystem == null && promptUser == null && promptNotes == null)
    return undefined;
  if (promptMode != null && promptMode !== "default" && promptMode !== "replace") {
    const appended = [promptNotes, promptSystem, promptUser].filter((t) => t?.trim());
    return { mode: "default", system: "", user: "", notes: appended.join("\n\n") };
  }
  return {
    mode: promptMode === "replace" ? "replace" : "default",
    system: promptSystem ?? "",
    user: promptUser ?? "",
    notes: promptNotes ?? "",
  };
}

/** Same table, `kind = "scripting"`. */
export function toProfile(row: EndpointRow, parts: EndpointParts): Profile {
  const pricing = toPricingConfig(row, parts);
  const prompt = toProfilePrompt(row);
  return {
    id: row.id.startsWith(PROFILE_KEY) ? row.id.slice(PROFILE_KEY.length) : row.id,
    name: row.name,
    model: row.model,
    inPrice: row.inPrice ?? 0,
    outPrice: row.outPrice ?? 0,
    ...(pricing ? { pricing } : {}),
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    concurrency: row.concurrency,
    maxChars: row.maxChars,
    splitAt: row.splitAt,
    maxOutputTokens: row.maxOutputTokens ?? 0,
    secPerChunk: row.secPerChunk ?? 0,
    needsKey: row.needsKey,
    ...(row.apiKey ? { hasKey: true } : {}),
    ...ops(row),
    // null means "leave it to the model" once the operational block exists, "unset" before
    ...(row.reasoningEffort != null || row.timeoutSec != null
      ? { reasoning: row.reasoningEffort }
      : {}),
    ...(prompt ? { prompt } : {}),
    ...(row.launch ? { launch: row.launch } : {}),
  };
}

/** Same table, `kind = "transcription"`; its rate is per minute. */
export function toTranscriber(row: EndpointRow, parts: EndpointParts): Transcriber {
  const pricing = toPricingConfig(row, parts);
  return {
    id: row.id.startsWith(TRANSCRIBER_KEY) ? row.id.slice(TRANSCRIBER_KEY.length) : row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    concurrency: row.concurrency,
    needsKey: row.needsKey,
    perMinute: row.billingRate ?? 0,
    ...(row.hotwordLambda != null ? { hotwordLambda: row.hotwordLambda } : {}),
    ...(row.resample16k ? {} : { resample16k: false }),
    ...(pricing ? { pricing } : {}),
    ...(row.apiKey ? { hasKey: true } : {}),
    ...ops(row),
    ...(row.launch ? { launch: row.launch } : {}),
  };
}

const opsValues = (e: Partial<EndpointOps> & { launch?: LocalServer | null }) => ({
  timeoutSec: e.timeoutSec ?? null,
  maxRetries: e.maxRetries ?? null,
  cooldownSec: e.cooldownSec ?? null,
  spendLimit: e.spendLimit ?? null,
  credentialId: e.credentialId ?? null,
  quotaGroup: e.quotaGroup ?? null,
  launch: e.launch ?? null,
});

/** `speedRange` is the server's to write (`writeSpeedRange`), never the page's. */
export function endpointValues(
  e: StoredEndpoint,
  position: number,
  apiKey: string | null = null,
  speedRange: SpeedRange | null = null,
): typeof endpoints.$inferInsert {
  return {
    id: e.id,
    kind: "tts",
    name: e.name,
    baseUrl: e.baseUrl,
    model: e.model,
    enabled: e.enabled,
    concurrency: e.concurrency,
    needsKey: e.needsKey,
    apiKey,
    maxChars: e.maxChars,
    splitAt: e.splitAt,
    position,
    price: e.price,
    latency: e.latency,
    failRate: e.failRate,
    billingUnit: e.billing?.unit ?? null,
    billingRate: e.billing?.rate ?? null,
    billingAudioRate: e.billing?.audioRate ?? null,
    audioTokensPerSecond: e.billing?.audioTokensPerSecond ?? null,
    billsInstructions: e.billing?.billsInstructions ?? null,
    parkedRates: e.billing?.parked ?? null,
    cachedInput: e.pricing?.cachedInput ?? null,
    cacheWrite: e.pricing?.cacheWrite ?? null,
    timezone: e.pricing?.timezone ?? null,
    expressionStatus: e.expressions?.status ?? null,
    expressionModel: e.expressions?.model ?? null,
    expressionBaseUrl: e.expressions?.baseUrl ?? null,
    expressionBrackets: e.expressions?.brackets ?? null,
    expressionOpen: e.expressions?.open ?? null,
    sampleRate: e.sampleRate ?? null,
    audioFormat: e.encoding?.format ?? null,
    audioBitrate: e.encoding?.bitrate ?? null,
    batch: e.batch ?? true,
    makesVoices: e.makesVoices ?? false,
    server: e.server ?? null,
    speedRange,
    ...opsValues(e),
  };
}

export function profileValues(
  p: Profile,
  position: number,
  apiKey: string | null = null,
): typeof endpoints.$inferInsert {
  return {
    id: profileKey(p.id),
    kind: "scripting",
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    enabled: p.enabled,
    concurrency: p.concurrency,
    needsKey: p.needsKey,
    apiKey,
    maxChars: p.maxChars,
    splitAt: p.splitAt,
    position,
    inPrice: p.inPrice,
    outPrice: p.outPrice,
    maxOutputTokens: p.maxOutputTokens,
    secPerChunk: p.secPerChunk,
    cachedInput: p.pricing?.cachedInput ?? null,
    cacheWrite: p.pricing?.cacheWrite ?? null,
    timezone: p.pricing?.timezone ?? null,
    ...opsValues(p),
    reasoningEffort: p.reasoning ?? null,
    promptMode: p.prompt?.mode ?? null,
    promptSystem: p.prompt?.system ?? null,
    promptUser: p.prompt?.user ?? null,
    promptNotes: p.prompt?.notes ?? null,
  };
}

export const voiceValues = (
  endpointId: string,
  v: Voice,
  position: number,
): typeof voices.$inferInsert => ({
  endpointId,
  id: v.id,
  label: v.label,
  gender: v.gender,
  speed: v.speed ?? null,
  profile: v.profile ?? null,
  position,
});

export const rateWindowValues = (
  endpointId: string,
  w: RateWindow,
  position: number,
): typeof rateWindows.$inferInsert => ({
  endpointId,
  id: w.id,
  label: w.label,
  days: w.days,
  fromMinute: w.from,
  toMinute: w.to,
  percent: w.percent ?? null,
  rates: w.rates ?? null,
  position,
});

export const promotionValues = (
  endpointId: string,
  p: Promotion,
  position: number,
): typeof promotions.$inferInsert => ({
  endpointId,
  id: p.id,
  label: p.label,
  fromAt: p.from,
  untilAt: p.until,
  scope: p.scope,
  percent: p.percent ?? null,
  rates: p.rates ?? null,
  note: p.note ?? null,
  position,
});

export const expressionTagValues = (
  endpointId: string,
  t: ExpressionTag,
  position: number,
): typeof expressionTags.$inferInsert => ({
  endpointId,
  id: t.id,
  label: t.label,
  token: t.token,
  kind: t.kind,
  position,
});

export function transcriberValues(
  t: Transcriber,
  position: number,
  apiKey: string | null = null,
): typeof endpoints.$inferInsert {
  return {
    id: transcriberKey(t.id),
    kind: "transcription",
    name: t.name,
    baseUrl: t.baseUrl,
    model: t.model,
    enabled: t.enabled,
    concurrency: t.concurrency,
    needsKey: t.needsKey,
    apiKey,
    position,
    billingUnit: "minute",
    billingRate: t.perMinute,
    hotwordLambda: t.hotwordLambda ?? null,
    resample16k: t.resample16k ?? true,
    timezone: t.pricing?.timezone ?? null,
    ...opsValues(t),
  };
}
