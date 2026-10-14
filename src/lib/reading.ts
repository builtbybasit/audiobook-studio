// A line's reading: exactly what a line is sent as, and whether a clip still matches it. Shared by
// browser and server so the ledger and the sender never disagree. A narration run
// (server/jobs/narration.ts) reads the line and cast at run start, the endpoint config, dictionary
// and pacing as each line goes out, and reads again as it lands (a mismatch lands stale).
import type { Endpoint, LexEntry, Pacing, Segment, SegmentAudio } from "@/types";
import { expressionParts, expressionPlan, type ExpressionPlan } from "@/lib/expressions";
import { sampleRateLabel, speechInstructions } from "@/lib/speech";
import { partsFor, type SplitPart } from "@/lib/split";

export interface Reader {
  /** none when the line has no voice to go to */
  endpoint: Endpoint | null | undefined;
  voiceRef?: string | null;
  style?: string;
}

export type ReadLine = Pick<Segment, "text" | "expressions" | "direction">;

export interface Reading {
  reader: Reader;
  /** after the dictionary, kept to what can be said, with the tags written in */
  plan: ExpressionPlan;
  instructions: string;
  /** cut at silent pauses and `maxChars`; null when not sent (no endpoint, or `plan.issues`) */
  cuts: SplitPart[] | null;
  /** a line held by a tag is counted cut the plain way, so it never estimates cheaper */
  requests: number;
}

/**
 * `maxChars` applies when shorter than the endpoint's own (a batch's limit). Null when the line is
 * not sent: no endpoint, a tag holds it, or a tag is longer than the limit (tags are never cut).
 */
export function cutReading(
  plan: ExpressionPlan,
  ep: Endpoint | null | undefined,
  maxChars?: number | null,
): SplitPart[] | null {
  if (!ep || plan.issues.length) return null;
  const limit = maxChars ? Math.min(ep.maxChars || maxChars, maxChars) : ep.maxChars;
  if (limit && plan.ranges.some((r) => r.to - r.from > limit)) return null;
  return expressionParts(plan, { maxChars: limit, splitAt: ep.splitAt });
}

export function prepareReading(
  line: ReadLine,
  reader: Reader,
  lexicon: LexEntry[],
  pacing: Pacing,
): Reading {
  const ep = reader.endpoint;
  const plan = expressionPlan(line, ep, lexicon, pacing);
  const cuts = cutReading(plan, ep);
  return {
    reader,
    plan,
    instructions: speechInstructions({ style: reader.style, direction: line.direction }),
    cuts,
    requests: !ep ? 0 : cuts ? cuts.length : partsFor(plan.text, ep),
  };
}

/** What a clip records so a later reading can be compared to it. */
export function readingRecord(
  line: Pick<Segment, "text" | "direction" | "type">,
  reading: Reading,
): Pick<
  SegmentAudio,
  | "direction"
  | "style"
  | "instructions"
  | "type"
  | "text"
  | "pronounced"
  | "expressionSignature"
  | "expressions"
  | "said"
  | "lex"
> {
  const { plan, instructions, reader } = reading;
  return {
    direction: line.direction,
    style: reader.style,
    ...(instructions ? { instructions } : {}),
    type: line.type,
    text: line.text,
    // recorded even when unchanged: `compareReading` holds it against the dictionary now
    pronounced: plan.pronounced,
    ...(plan.signature ? { expressionSignature: plan.signature } : {}),
    ...(plan.tags.length ? { expressions: plan.tags } : {}),
    ...(plan.text !== line.text ? { said: plan.text, lex: plan.hits.length } : {}),
  };
}

/**
 * Whether the dictionary now makes other words of a clip's line. Compares dictionary output, not
 * the whole text sent, so a change to the `sayable` rule does not stale old clips. Null for a clip
 * that records no words. The one rule for every dictionary question.
 */
export function pronunciationMoved(
  a: Pick<SegmentAudio, "pronounced" | "said" | "text">,
  pronounced: string,
): boolean | null {
  const sent = a.pronounced ?? a.said ?? a.text;
  return sent == null ? null : sent !== pronounced;
}

/**
 * What a clip was rendered with that the reading no longer says; empty means current. Rate is only
 * checked when the endpoint names one, and format never (a WAV clip is fine after a move to MP3).
 */
export function compareReading(
  a: SegmentAudio,
  s: Pick<Segment, "text" | "direction" | "type">,
  now: Reading,
  voiceLabel: (ref: string | null | undefined) => string = (ref) => ref ?? "",
): string[] {
  if (!a.at) return [];
  const out: string[] = [];
  if (a.text != null && a.text !== s.text)
    out.push(
      a.text.length === s.text.length
        ? "text: edited"
        : `text: ${a.text.length} → ${s.text.length} chars`,
    );
  if (a.text === s.text && pronunciationMoved(a, now.plan.pronounced))
    out.push("pronunciation: the dictionary changed after this clip");
  if ((a.expressionSignature ?? "") !== now.plan.signature)
    out.push("expressions: tags, pauses, position, or model support changed after this clip");
  if ((a.direction || "") !== (s.direction || ""))
    out.push(`direction: “${a.direction || "—"}” → “${s.direction || "—"}”`);
  if (a.type && a.type !== s.type) out.push(`type: ${a.type} → ${s.type}`);
  const { reader } = now;
  if (a.voiceRef && reader.voiceRef !== a.voiceRef)
    out.push(`voice: ${voiceLabel(a.voiceRef)} → ${voiceLabel(reader.voiceRef) || "unset"}`);
  const rate = reader.endpoint?.sampleRate;
  if (a.sampleRate && rate && a.sampleRate !== rate)
    out.push(`sample rate: ${sampleRateLabel(a.sampleRate)} → ${sampleRateLabel(rate)}`);
  if ((a.style ?? "") !== (reader.style ?? ""))
    out.push(`style: “${a.style || "—"}” → “${reader.style || "—"}”`);
  return out;
}
