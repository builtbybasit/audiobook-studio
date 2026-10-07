// The port a scripting model is reached through.
//
// A scripting job hands a provider a chapter's prose and gets back lines with speakers. What model,
// what prompt and what key are the provider's business; what each request used it reports through
// `sent`, and the job prices that into the ledger (`sent.ts`). A key, when there is one, is the
// profile's own, read from the database at the moment of dispatch (`target.ts`), and never leaves
// the process.
//
// Two implementations: the fake, which reads the prose and never the network, and the one that
// calls the profile the run was queued with (`chatScripting.ts`). A server runs with both, and
// sends each run to the one its profile names (`endpointScripting.ts`): a simulated profile to
// the fake, every other to its model.
import type {
  EndpointProbe,
  PromptTemplate,
  ReasoningEffort,
  RenderedPrompt,
  SegmentType,
} from "@/types";
import type { PromptCastMember, ScriptedTag } from "@/lib/prompt";
import type { SentScript } from "~/providers/sent";
import type { ProviderTarget } from "~/providers/target";

/** A profile as a request needs it: the target, and how long an answer may be. */
export interface ScriptTarget extends ProviderTarget {
  /** the profile's cap on output tokens; 0 = let the model decide */
  maxOutputTokens: number;
  /** how hard a reasoning model is asked to think; absent or null sends nothing and leaves it to the model */
  reasoning?: ReasoningEffort | null;
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
   * reads only its simulation; a real provider refuses a run without one rather than guessing
   * where to send it.
   */
  target: ScriptTarget | null;
  /**
   * The speakers the book already has, so a chunk read on its own still calls Mara "Mara" and not
   * "the girl". Names only, Narrator included; a provider may ignore it.
   */
  cast: string[];
  /**
   * The two messages to send, rendered by the job from the prompt the run was queued with
   * (`@/lib/prompt`). Absent, a provider that sends a prompt builds the built-in one from `title`,
   * `cast` and `text`. The fake reads none of it.
   */
  prompt?: RenderedPrompt;
  /**
   * Hand back the lines even when they fail the word-for-word check, instead of refusing them — for
   * a prompt trial, which shows what came back and the check beside it. A run never sets it.
   */
  lenient?: boolean;
  /** called once for every request that reached the wire, answered or not; see `sent.ts` */
  sent?(request: SentScript): void;
}

/** One line the model attributed. The job gives it an id and a place. */
export interface ScriptedLine {
  type: SegmentType;
  speaker: string;
  text: string;
  direction?: string;
  /** expression tags the model wrote into the line, read out of its text */
  tags?: ScriptedTag[];
}

/**
 * What one request came back with: the lines, and what the model noticed beside them. Neither of
 * the two extras is checked against the prose, and neither can change a word of the script — a
 * wrong one misleads who a later line is given to, which a person can see and correct.
 */
export interface ScriptAnswer {
  lines: ScriptedLine[];
  /** what the excerpt says of its speakers; absent from a provider that does not ask */
  cast?: PromptCastMember[];
  /** where the excerpt leaves off, for whoever scripts the text after it */
  recap?: string;
}

export interface ScriptingProvider {
  /** what the Queue page names, and the log */
  readonly name: string;
  /**
   * Whether the work goes to the profile's own model, so the history can name that model rather
   * than the provider — which for the fake is the honest answer.
   */
  readonly callsProfile?: boolean;
  script(input: ScriptInput): Promise<ScriptAnswer>;
  /**
   * One small request to see the profile answers — the Test button; absent, it cannot be tested.
   * `prompt` is the template the profile's runs would be sent (the library's, or its own
   * replacement) and the profile's notes, filled in with `sampleVars`; absent, the built-in one.
   */
  probe?(
    target: ScriptTarget,
    signal: AbortSignal,
    prompt?: { template: PromptTemplate; notes: string },
  ): Promise<EndpointProbe>;
}
