// The port a scripting model is reached through.
//
// A scripting job hands a provider a chapter's prose and gets back lines with speakers. That is the
// whole contract: what model, what prompt, what key and what it cost are the provider's business,
// and the job neither knows nor stores any of it. A key, when there is one, is read by the provider
// from the server's own environment and never leaves the process — see `docs/backend.md`.
//
// Only the fake exists today, and it is selected explicitly. Nothing here can spend money.
import type { SegmentType } from "@/types";

export interface ScriptInput {
  title: string;
  /** the chapter as `plainText` reads it — no Markdown, no link addresses, nothing to bill twice */
  text: string;
  /** aborted when the job is cancelled; a provider that is mid-request should stop */
  signal: AbortSignal;
  /** how far along, for the queue's progress bar */
  progress?(done: number, total: number): void;
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
  script(input: ScriptInput): Promise<ScriptedLine[]>;
}

/** Which provider a server is started with. Only `fake` is implemented; see `env.ts`. */
export type ScriptingProviderName = "fake";
