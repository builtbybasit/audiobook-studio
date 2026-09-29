// Scripting: the LLM side. A profile is one chat endpoint, the telemetry is what its requests in
// the server's ledger say it has been through, and the estimate and the diff are what the Scripting
// page shows before and after a run.
import type { SplitMode } from "@/types/common";
import type { PricingConfig, RateEstimate } from "@/types/pricing";
import type { Segment } from "@/types/segment";

/** What a profile's settled requests say it has been through (`scriptTelemetry`). */
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
    /** the chapter the request was for; null once the book or the chapter is gone */
    bookId: string | null;
    chapterId: number | null;
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
