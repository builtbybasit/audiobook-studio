// A line's reading: exactly what a line is sent as, and whether a clip still matches it.
//
// The browser and the server both ask this of a line — the browser to estimate a run, show what a
// line will send and say why a clip is out of date; the server to price the line, send it, record
// it on the clip and judge a clip that lands after the book changed under it — so it is worked out
// here once, from what each side holds. Two copies of these rules are how the ledger calls a clip
// current while the server would send the line differently, or the other way round.
//
// A reading is the line after the book's pronunciation dictionary, kept to what a voice can say
// (`sayable`), with its expression tags — the scripting model's and the ones placed by hand —
// written in as the speaker's endpoint spells them (`expressionPlan`); the voice instructions sent
// beside it (`speechInstructions`); and where it is cut to fit the endpoint's `maxChars`
// (`expressionParts`, each tag kept whole). A clip records what of it can move afterwards
// (`readingRecord`), and `compareReading` holds that record against the line's reading now.
//
// What a reading is taken from, and when. The browser reads everything as it stands, every time.
// A narration run (`server/jobs/narration.ts`) takes some of it once, when the run starts, and the
// rest as each line goes out, and the rule is:
//
// - **at run start**: the line itself (its text, tags, direction and type, as `planRun` read the
//   chapter), the cast — who reads each line, in which voice, on which endpoint, with which style
//   (`bookDelivery`) — whether thoughts are read plain, and which endpoints take batches and how
//   large. A cast edit mid-run is the edit's to mark stale; a switch flipped applies to the next run.
// - **as each line goes out**: the endpoint's saved configuration — its tags and brackets, its
//   `maxChars` and `splitAt`, its rate, format and key — and the book's dictionary, so a term added
//   or a tag defined mid-run reaches every line not yet sent; the price the line holds is worked
//   out at that moment too. The endpoint's concurrency and pause are read by the gate every time it
//   looks.
// - **as each line lands**: the dictionary and the endpoint once more, to take the line's reading
//   again with the same line and voice it went out with, and a clip that no longer matches lands
//   stale.
import type { Endpoint, LexEntry, Segment, SegmentAudio } from "@/types";
import { expressionParts, expressionPlan, type ExpressionPlan } from "@/lib/expressions";
import { sampleRateLabel, speechInstructions } from "@/lib/speech";
import { partsFor, type SplitPart } from "@/lib/split";

/** Who reads a line, as far as its reading goes: the voice, the endpoint that owns it, the style. */
export interface Reader {
  /** the speaker's endpoint as saved, or none when the line has no voice to go to */
  endpoint: Endpoint | null | undefined;
  voiceRef?: string | null;
  style?: string;
}

/** What a reading needs of the line. */
export type ReadLine = Pick<Segment, "text" | "expressions" | "direction">;

/** Exactly what a line is sent as. */
export interface Reading {
  reader: Reader;
  /** the words: after the dictionary, kept to what can be said, with the tags written in */
  plan: ExpressionPlan;
  /** the voice instructions sent beside the line; empty when there is nothing to say */
  instructions: string;
  /**
   * Where the line is cut at the endpoint's `maxChars`, one part when it fits; null when it is not
   * sent at all — there is no endpoint, or a tag holds it (`plan.issues`).
   */
  cuts: SplitPart[] | null;
  /**
   * How many requests the line is billed as: its parts, or — held by a tag — cut the plain way, so
   * an estimate never reads cheaper for a line that needs attention. None with no endpoint.
   */
  requests: number;
}

/**
 * Where `plan` is cut for `ep`, at `maxChars` when that is shorter than the endpoint's own limit —
 * a batch that takes shorter items than the endpoint does — or null when the line is not sent: no
 * endpoint, a tag holds it, or a tag is longer than that shorter limit, since a tag is never cut.
 * (One longer than the endpoint's own limit is already a tag that holds the line.)
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

/** A line's reading by `reader`, with the book's dictionary as `lexicon` holds it. */
export function prepareReading(line: ReadLine, reader: Reader, lexicon: LexEntry[]): Reading {
  const ep = reader.endpoint;
  const plan = expressionPlan(line, ep, lexicon);
  const cuts = cutReading(plan, ep);
  return {
    reader,
    plan,
    instructions: speechInstructions({ style: reader.style, direction: line.direction }),
    cuts,
    requests: !ep ? 0 : cuts ? cuts.length : partsFor(plan.text, ep),
  };
}

/** What a clip records of its reading, beside its voice, so a later reading can be compared to it. */
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
    // what the dictionary made of it, recorded whether or not it changed anything: the
    // pronunciation half of `compareReading` holds this against the dictionary as it now stands
    pronounced: plan.pronounced,
    ...(plan.signature ? { expressionSignature: plan.signature } : {}),
    ...(plan.tags.length ? { expressions: plan.tags } : {}),
    ...(plan.text !== line.text ? { said: plan.text, lex: plan.hits.length } : {}),
  };
}

/**
 * Whether the dictionary now makes other words of a clip's line than the clip was sent: `pronounced`
 * is what it makes of the line now (`speak`, or a reading's `plan.pronounced`). Null for a clip that
 * records no words.
 *
 * Held against what the dictionary made of the line when it was sent — `pronounced`, or for a clip
 * from before that was kept, the text sent or the line — never the text sent whole, which also
 * carries what can be said of a line: a clip rendered before that rule last changed would read as
 * out of date though neither its line nor its dictionary moved. One rule for every question about
 * the dictionary — the drift below, the clips a dictionary change stales, the ones its Undo puts
 * back, and the count the dictionary's dialog warns of.
 */
export function pronunciationMoved(
  a: Pick<SegmentAudio, "pronounced" | "said" | "text">,
  pronounced: string,
): boolean | null {
  const sent = a.pronounced ?? a.said ?? a.text;
  return sent == null ? null : sent !== pronounced;
}

/**
 * Everything a clip was rendered with that the line's reading now no longer says, in words — empty
 * means "still current". `voiceLabel` names a voice for the sentence; the server needs no names.
 *
 * The words are judged by what the dictionary made of them (`pronunciationMoved`) and by the tags
 * (`expressionSignature`), not by the text sent whole. A rate is only asked about when the endpoint names
 * one — one left on the model's own asks for nothing, so no clip it made is at the wrong rate — and
 * the format never is: a WAV clip is as good a clip after its endpoint moves to MP3.
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
  // the words themselves are unchanged but the dictionary now sends different ones
  if (a.text === s.text && pronunciationMoved(a, now.plan.pronounced))
    out.push("pronunciation: the dictionary changed after this clip");
  if ((a.expressionSignature ?? "") !== now.plan.signature)
    out.push("expressions: tags, position, or model support changed after this clip");
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
