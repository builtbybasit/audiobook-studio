// The port a scripting model is reached through.
//
// A scripting job hands a provider a chapter's prose and gets back lines with speakers. What model,
// what prompt and what key are the provider's business; what each request used it reports through
// `sent`, and the job prices that into the ledger (`sent.ts`). A key, when there is one, is read by the provider
// from the server's own environment and never leaves the process — see `docs/backend.md`.
//
// Two implementations: the fake, which reads the prose and never the network, and the one that
// calls the profile the run was queued with (`SCRIPTING_PROVIDER=endpoints`).
import type { SegmentType } from "@/types";
import type { SentScript } from "~/providers/sent";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

/** A profile as a request needs it: the target, and how long an answer may be. */
export interface ScriptTarget extends ProviderTarget {
  /** the profile's cap on output tokens; 0 = let the model decide */
  maxOutputTokens: number;
}

export interface ScriptInput {
  title: string;
  /** the chapter as `plainText` reads it — no Markdown, no link addresses, nothing to bill twice */
  text: string;
  /** aborted when the job is cancelled; a provider that is mid-request should stop */
  signal: AbortSignal;
  /** how far along, for the queue's progress bar */
  progress?(done: number, total: number): void;
  /**
   * The profile the run was queued with, and its key; null when the run named none. The fake
   * ignores it; a real provider refuses a run without one rather than guessing where to send it.
   */
  target: ScriptTarget | null;
  /**
   * The speakers the book already has, so a chunk read on its own still calls Mara "Mara" and not
   * "the girl". Names only, Narrator included; a provider may ignore it.
   */
  cast: string[];
  /** called once for every request that reached the wire, answered or not; see `sent.ts` */
  sent?(request: SentScript): void;
}

/** One line the model attributed. The job gives it an id and a place. */
export interface ScriptedLine {
  type: SegmentType;
  speaker: string;
  text: string;
  direction?: string;
}

export interface ScriptingProvider {
  /** what the Queue page names, and the log */
  readonly name: string;
  /**
   * Whether the work goes to the profile's own model, so the history can name that model rather
   * than the provider — which for the fake is the honest answer.
   */
  readonly callsProfile?: boolean;
  script(input: ScriptInput): Promise<ScriptedLine[]>;
  /** one small request to see the profile answers — the Test button; absent, it cannot be tested */
  probe?(target: ScriptTarget, signal: AbortSignal): Promise<ProbeResult>;
}

/** Which provider a server is started with; see `env.ts`. */
export type ScriptingProviderName = "fake" | "endpoints";
