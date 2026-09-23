// Scripting: the LLM side. A profile is one chat endpoint, the telemetry is what this session
// observed from it, and the estimate and the diff are what the Scripting page shows before and
// after a run.
import type { SplitMode } from "@/types/common";
import type { PricedRequest, PricingConfig, RateEstimate } from "@/types/pricing";
import type { Segment, SegmentType } from "@/types/segment";

/** Session-only observations from simulated scripting requests. */
export interface ScriptEndpointTelemetry {
  completed: number;
  failures: number;
  rateLimits: number;
  backoffUntil: number;
  lastSuccess: number;
  history: { at: number; ms: number; ok: boolean }[];
  lastError?: {
    code: number;
    message: string;
    body: string;
    at: number;
    bookId: string;
    chapterId: number;
    model: string;
    baseUrl: string;
  };
}

/** An LLM provider used for scripting (splitting prose into attributed segments). */
export interface Profile {
  id: string;
  name: string;
  model: string;
  /** USD per million input tokens — the base rate, before any schedule or promotion */
  inPrice: number;
  /** USD per million output tokens — the base rate, before any schedule or promotion */
  outPrice: number;
  /**
   * Everything the two rates above cannot express: cached-input and cache-write rates, a
   * peak/off-peak schedule with its timezone, and temporary promotions. Optional so a profile
   * saved before it existed still loads; `ensurePricing` fills the defaults in on first use, and
   * an endpoint with no advanced pricing has an empty schedule and no promotions.
   */
  pricing?: PricingConfig;
  baseUrl: string;
  enabled: boolean;
  concurrency: number;
  maxChars: number;
  splitAt: SplitMode;
  maxOutputTokens: number;
  secPerChunk: number;
  needsKey: boolean;
  /**
   * Backend only, and only ever read: the server holds a key for this endpoint. The key itself
   * never comes back from the server.
   */
  hasKey?: boolean;
  /**
   * Backend only, and only ever sent: a key for the server to keep for this endpoint. Left out, a
   * save keeps the one already kept; `""` forgets it.
   */
  apiKey?: string;
  // operational settings — see EndpointOps; optional so older saved profiles still load
  timeoutSec?: number;
  maxRetries?: number;
  cooldownSec?: number;
  spendLimit?: number | null;
  credentialId?: string | null;
  quotaGroup?: string | null;
}

export interface ScriptSettings {
  profile: string;
  stripWatermarks: boolean;
  /** re-apply the manual corrections of the script a run replaces, where the line still matches */
  keepEdits: boolean;
}

/** One segment whose speaker or direction moved between two script runs. */
export interface DiffChange {
  id: number;
  text: string;
  from: string;
  to: string;
}

export interface ScriptDiff {
  speaker: DiffChange[];
  direction: DiffChange[];
  added: Segment[];
  removed: Segment[];
  total: number;
  prevCount: number;
  curCount: number;
}

/**
 * What happened to the manual corrections a re-script was asked to preserve. A correction is
 * re-applied when the new script still has the line it was made on; one whose line the new run
 * wrote differently cannot be, and is named here rather than quietly dropped — the reader shows
 * these so "preserved" is never claimed for a correction that was not.
 */
export interface RescriptReport {
  /** the endpoint that produced the new script */
  profile: string;
  model: string;
  /** whether preservation was asked for at all */
  asked: boolean;
  kept: number;
  unmatched: {
    speaker: string;
    text: string;
    direction: string;
    type: SegmentType;
  }[];
}

export interface ScriptEstimate {
  chapters: number;
  chars: number;
  chunks: number;
  seconds: number;
  /** the conservative total: no cache savings, at the rates in force right now */
  cost: number;
  profile: Profile | undefined;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  blockers: string[];
  /** the same numbers priced: the alternatives, and what could move the figure before the run ends */
  rates: RateEstimate | null;
}

/** One completed scripting request, kept with the rates it was charged at. */
export interface ScriptUsageRecord {
  bookId: string;
  profileId: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** the receipt — usage, rates and reasoning, frozen when the request completed */
  priced?: PricedRequest;
}
