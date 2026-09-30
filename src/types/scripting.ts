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
  /**
   * What the endpoint's recent requests at its current reasoning level spent thinking, as a share of
   * their input tokens — how a run's estimate adds the thinking a reasoning model will bill as
   * output. Absent until such a request reported its reasoning tokens.
   */
  reasoning?: { perInputToken: number; requests: number };
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

// ---- the prompt: see `@/lib/prompt` for how these are layered and filled in ----

/** How hard a reasoning model thinks before it answers; absent or null leaves it to the model. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** The two messages a request is built from, before its tags are filled in. */
export interface PromptTemplate {
  system: string;
  user: string;
}

/**
 * A scripting endpoint's say over the prompt: its notes, which `{{endpoint.notes}}` places in
 * whichever prompt is sent, and a whole prompt of its own it may send instead of the library's.
 * `default` keeps the replacement's text without sending it, so switching back finds it again.
 */
export interface ProfilePrompt extends PromptTemplate {
  mode: "default" | "replace";
  notes: string;
}

/** A book's say over the prompt: notes for `{{book.notes}}`, and a replacement it may switch on. */
export interface BookPrompt extends PromptTemplate {
  notes: string;
  /** on: `system` and `user` are this book's whole prompt; off, they are kept but not used */
  replace: boolean;
}

/** Where a request's prompt came from, as the run and the chapter's history record it. */
export interface PromptOrigin {
  /** whose template is the base */
  from: "built-in" | "library" | "endpoint" | "book";
  /** a short hash of the template, tags unfilled — the same text always gives the same one */
  fingerprint: string;
}

/** A template with the layers resolved: what a run snapshots when it is queued. */
export interface ResolvedPrompt extends PromptTemplate {
  origin: PromptOrigin;
}

/** The two messages as they are sent, tags filled and the output format added. */
export interface RenderedPrompt {
  system: string;
  user: string;
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
  /** how hard a reasoning model thinks; absent or null sends nothing and leaves it to the model */
  reasoning?: ReasoningEffort | null;
  /** this endpoint's say over the prompt; absent is `default` with no text */
  prompt?: ProfilePrompt | null;
}

export interface ScriptSettings {
  /** the profile runs go to, by id; null until one is picked, when the first usable one is used */
  profile: string | null;
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
  /**
   * What the book may still spend on scripting: the lower of its scripting budget and its overall
   * cap, less what is spent and held. Infinity when neither is set; below zero when overspent;
   * NaN while the book's spending has not been read, which blocks the run until it has.
   */
  remaining: number;
  /** chapters whose text has not been read yet, so nothing above counts them: not ready to run */
  reading: number;
}

// ---- trying a prompt on one chunk ----

/**
 * One chunk of a chapter sent with a prompt that need not be saved yet, to see what comes back.
 * Nothing is written to the script; the request is real, priced into the book's ledger and held to
 * its budget like any other.
 */
export interface PromptTrialRequest {
  /** the scripting endpoint to send it to, by its id */
  profile: string;
  chapterId: number;
  /** which of the chapter's chunks, cut as the endpoint cuts it, 1-based; default 1 */
  part?: number;
  /**
   * Drafts in place of what is saved, each layer on its own; absent sends the saved one. `null`
   * for `library` is the built-in prompt; `null` for the others is none.
   */
  library?: PromptTemplate | null;
  profilePrompt?: ProfilePrompt | null;
  book?: BookPrompt | null;
}

/** What one trial came back with. A refused answer is a result too, not an error. */
export interface PromptTrialResult {
  /** the two messages exactly as they were sent */
  prompt: RenderedPrompt;
  part: number;
  parts: number;
  /** the excerpt that was sent */
  excerpt: string;
  /** the lines the model answered with, even when they fail the word check */
  lines: {
    type: "narration" | "dialogue" | "thought";
    speaker: string;
    text: string;
    direction?: string;
  }[];
  /** the word-for-word check a run would hold them to */
  fidelity: { words: number; missing: number; added: number; examples: string[]; ok: boolean };
  ms: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number | null } | null;
  /** USD, as the ledger priced it; null when it could not be priced */
  cost: number | null;
  /** what went wrong when there are no lines to show: the provider refused, the answer was not a script… */
  error?: string;
}
