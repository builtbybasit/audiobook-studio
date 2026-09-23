// Endpoints and scripting profiles, between rows and the shapes the app configures.
//
// **Configuration is stored; telemetry is not.** An `Endpoint` carries both — `history`,
// `failures`, `rateLimits`, `backoffUntil`, `lastError` and `fetching` are what this session has
// observed, not what anybody configured. None of it is persisted here, and reading an endpoint back
// returns those fields empty, because the durable record of what an endpoint has done is the
// `requests` ledger. Writing a backoff deadline to disk would mean a server restart could resurrect
// a cooldown for a rate limit that expired days ago.
import type {
  Endpoint,
  ExpressionConfig,
  ExpressionTag,
  PricingConfig,
  Profile,
  Promotion,
  RateWindow,
  TtsBilling,
  Voice,
} from "@/types";
import type { endpoints, expressionTags, promotions, rateWindows, voices } from "~/db/schema";

type EndpointRow = typeof endpoints.$inferSelect;
type VoiceRow = typeof voices.$inferSelect;
type WindowRow = typeof rateWindows.$inferSelect;
type PromotionRow = typeof promotions.$inferSelect;
type TagRow = typeof expressionTags.$inferSelect;

/**
 * A speech endpoint as it is configured: everything but what this session observed of it, which
 * is what a save sends and what `endpointValues` writes.
 */
export type EndpointSettings = Omit<
  Endpoint,
  "history" | "failures" | "rateLimits" | "backoffUntil" | "lastError" | "fetching"
>;

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

/** The rate card, or nothing when this endpoint has never had one configured. */
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
  return {
    status: row.expressionStatus,
    model: row.expressionModel ?? "",
    baseUrl: row.expressionBaseUrl ?? "",
    tags: byPosition(parts.tags).map(toExpressionTag),
  };
}

/**
 * The operational settings both kinds share — all six, or none.
 *
 * They arrive together: the app fills the whole block in on first use, and the three nullable ones
 * mean something specific when they are null. `spendLimit: null` is "no endpoint-level limit" and
 * `credentialId: null` is "this endpoint's own key slot" — both are settings, not absences, and
 * dropping them because they are null would be a different endpoint coming back.
 *
 * `timeoutSec` is the marker for the block, being the one field that is always a number once the
 * block exists at all. An endpoint without the block can still name a credential, a quota group
 * or a limit on its own — the seeded ones do, before the page fills the rest in — and those are
 * read back as they were set, since there a null can only mean "never set".
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

/**
 * A speech endpoint.
 *
 * The telemetry fields come back empty on purpose — see the note at the top of this file.
 */
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
  return e;
}

/**
 * Where a scripting profile's row is kept.
 *
 * The two kinds share a table, but not a namespace: the app keys them `tts:<id>` and
 * `scripting:<id>`, and the seeded world has a speech endpoint and a scripting profile that are
 * both `openai`. A speech endpoint keeps its bare id, because a character's voice names it —
 * `<endpointId>/<voiceId>` — and the narration job looks it up by that; a profile's row is kept
 * under the page's own key for it, so the two never meet.
 */
export const PROFILE_KEY = "scripting:";
export const profileKey = (id: string): string => PROFILE_KEY + id;

/** A scripting profile. Same table, `kind = "scripting"`. */
export function toProfile(row: EndpointRow, parts: EndpointParts): Profile {
  const pricing = toPricingConfig(row, parts);
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
    ...ops(row),
  };
}

const opsValues = (e: Partial<EndpointSettings>) => ({
  timeoutSec: e.timeoutSec ?? null,
  maxRetries: e.maxRetries ?? null,
  cooldownSec: e.cooldownSec ?? null,
  spendLimit: e.spendLimit ?? null,
  credentialId: e.credentialId ?? null,
  quotaGroup: e.quotaGroup ?? null,
});

export function endpointValues(
  e: EndpointSettings,
  position: number,
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
    sampleRate: e.sampleRate ?? null,
    ...opsValues(e),
  };
}

export function profileValues(p: Profile, position: number): typeof endpoints.$inferInsert {
  return {
    id: profileKey(p.id),
    kind: "scripting",
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    enabled: p.enabled,
    concurrency: p.concurrency,
    needsKey: p.needsKey,
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
