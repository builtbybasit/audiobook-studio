// Scripting, the LLM side: a profile is one chat endpoint; its telemetry comes from the server's
// ledger; the estimate and diff are what the Scripting page shows before and after a run.
import type { Age, Gender, SplitMode } from "@/types/common";
import type { PricingConfig, RateEstimate } from "@/types/pricing";
import type { ScriptedTag } from "@/types/expression";
import type { Segment, SegmentType } from "@/types/segment";

/** What a profile's settled requests say it has been through (`scriptTelemetry`). */
export interface ScriptEndpointTelemetry {
  completed: number;
  failures: number;
  rateLimits: number;
  backoffUntil: number;
  lastSuccess: number;
  history: { at: number; ms: number; ok: boolean }[];
  /**
   * Recent reasoning tokens per input token at the current reasoning level, so an estimate can add
   * the thinking billed as output. Absent until a request reported reasoning tokens.
   */
  reasoning?: { perInputToken: number; requests: number };
  lastError?: {
    code: number;
    message: string;
    body: string;
    at: number;
    /** null once the book or the chapter is gone */
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
 * An endpoint's notes (`{{endpoint.notes}}`) and a whole prompt it may send instead of the
 * library's. `default` keeps the replacement's text unsent, so switching back finds it.
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
  /** a short hash of the template, tags unfilled */
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

/** An LLM endpoint used for scripting (splitting prose into attributed segments). */
export interface Profile {
  id: string;
  name: string;
  model: string;
  /** USD per million input tokens, before any schedule or promotion */
  inPrice: number;
  /** USD per million output tokens, before any schedule or promotion */
  outPrice: number;
  /** Cache rates, schedule and promotions. `ensurePricing` fills defaults on first use. */
  pricing?: PricingConfig;
  baseUrl: string;
  enabled: boolean;
  concurrency: number;
  maxChars: number;
  splitAt: SplitMode;
  maxOutputTokens: number;
  secPerChunk: number;
  needsKey: boolean;
  /** Read only: the server holds a key for this endpoint. The key itself never comes back. */
  hasKey?: boolean;
  /** Sent only: a key for the server to keep. Left out, a save keeps the key; `""` forgets it. */
  apiKey?: string;
  // operational settings — see EndpointOps
  timeoutSec?: number;
  maxRetries?: number;
  cooldownSec?: number;
  spendLimit?: number | null;
  credentialId?: string | null;
  quotaGroup?: string | null;
  /** absent or null sends nothing and leaves it to the model */
  reasoning?: ReasoningEffort | null;
  /** absent is `default` with no text */
  prompt?: ProfilePrompt | null;
}

export interface ScriptSettings {
  /** by id; null until one is picked, when the first usable one is used */
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
  /** no cache savings, at the rates in force right now */
  cost: number;
  profile: Profile | undefined;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  blockers: string[];
  /** the alternatives, and what could move the figure before the run ends */
  rates: RateEstimate | null;
  /**
   * Scripting budget left: the lower of the script budget and the overall cap, less spent and held.
   * Infinity when neither is set; NaN until the book's spending is read, which blocks the run.
   */
  remaining: number;
  /** chapters whose text has not been read yet, so nothing above counts them; blocks the run */
  reading: number;
}

// ---- trying a prompt on one chunk ----

/** A real, priced request held to the budget, but nothing is written to the script. */
export interface PromptTrialRequest {
  profile: string;
  chapterId: number;
  /** which chunk, cut as the endpoint cuts it, 1-based; default 1 */
  part?: number;
  /**
   * Drafts in place of each saved layer; absent sends the saved one. `null` is the built-in prompt
   * for `library`, none for the others.
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
  excerpt: string;
  /** the lines the model answered with, even when they fail the word check */
  lines: {
    type: SegmentType;
    speaker: string;
    text: string;
    direction?: string;
    /** expression tags the model wrote into the line, as a run would keep them */
    tags?: ScriptedTag[];
    /** the line effects the model named, as it wrote them; a run keeps only the library's */
    effects?: string[];
  }[];
  /** the word-for-word check a run would hold them to */
  fidelity: { words: number; missing: number; added: number; examples: string[]; ok: boolean };
  /** what the model said of the speakers; a run fills the cast in from it */
  cast: {
    name: string;
    gender?: Gender;
    age?: Age;
    aliases?: readonly string[];
    description?: string;
  }[];
  /** where the model said the excerpt leaves off; a run keeps it for the next chapter */
  recap?: string;
  ms: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number | null } | null;
  /** USD; null when it could not be priced */
  cost: number | null;
  /** why there are no lines: the provider refused, the answer was not a script… */
  error?: string;
}
