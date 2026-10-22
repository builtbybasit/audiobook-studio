// The port a scripting model is reached through: a chapter's prose in, attributed lines out. Each
// request is reported through `sent` for the ledger (`sent.ts`). `endpointScripting.ts` sends a
// simulated profile to the fake and every other to `chatScripting.ts`.
import type {
  EndpointProbe,
  PromptTemplate,
  ReasoningEffort,
  RenderedPrompt,
  ScriptedTag,
  SegmentType,
} from "@/types";
import type { PromptCastMember } from "@/lib/prompt";
import type { SentScript } from "~/providers/sent";
import type { ProviderTarget } from "~/providers/target";

export interface ScriptTarget extends ProviderTarget {
  /** 0 = let the model decide */
  maxOutputTokens: number;
  /** absent or null sends nothing and leaves it to the model */
  reasoning?: ReasoningEffort | null;
}

export interface ScriptInput {
  title: string;
  /** as `plainText` reads it: no Markdown, no link addresses */
  text: string;
  signal: AbortSignal;
  progress?: (done: number, total: number) => void;
  /** null when the run named none; a real provider then refuses rather than guessing */
  target: ScriptTarget | null;
  /** the book's speaker names, Narrator included, so a lone chunk keeps them; may be ignored */
  cast: string[];
  /** rendered by the job (`@/lib/prompt`); absent, the built-in one is built from the input */
  prompt?: RenderedPrompt;
  /** for a prompt trial: return lines that fail the word check instead of refusing them */
  lenient?: boolean;
  /** called once for every request that reached the wire, answered or not; see `sent.ts` */
  sent?: (request: SentScript) => void;
  /** set when `prompt` asks for a few lines of an earlier answer back (`repairPrompt`) */
  repair?: ScriptRepair;
}

/** A refused answer, sent back for the model to fix only the lines that part from the book. */
export interface ScriptRepair {
  answer: ScriptAnswer;
  content: string;
  /** 1-based and inclusive, in the answer's own numbering */
  ranges: { from: number; to: number }[];
  /** told after the prompt it answered */
  note: string;
}

/** One line the model attributed. The job gives it an id and a place. */
export interface ScriptedLine {
  type: SegmentType;
  speaker: string;
  text: string;
  direction?: string;
  /** expression tags read out of the text */
  tags?: ScriptedTag[];
  /** by name as the model wrote them; the job matches them to ids */
  effects?: string[];
}

/** The lines, plus extras that are not checked against the prose and cannot change a word. */
export interface ScriptAnswer {
  lines: ScriptedLine[];
  cast?: PromptCastMember[];
  /** where the excerpt leaves off, for whoever scripts the text after it */
  recap?: string;
  /** dictionary terms the model suggests */
  pronounce?: { term: string; say: string }[];
  /** lines the model had out of the book's order, put back; its k-th line is `lines[modelOrder[k]]` */
  reordered?: { modelOrder: number[]; moved: number };
  /** words put back from the book where the model left out, added or changed a few */
  patched?: number;
}

export interface ScriptingProvider {
  readonly name: string;
  /** whether the profile's own model does the work, so the history names that model */
  readonly callsProfile?: boolean;
  script(input: ScriptInput): Promise<ScriptAnswer>;
  /** the Test button; `prompt` absent means the built-in one, filled with `sampleVars` */
  probe?(
    target: ScriptTarget,
    signal: AbortSignal,
    prompt?: { template: PromptTemplate; notes: string },
  ): Promise<EndpointProbe>;
}
