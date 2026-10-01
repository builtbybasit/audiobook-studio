// What narration will cost before it is sent, and what a run holds against the book's cap.
//
// The figure the page's run strip checks the cap against, on rows: every line goes to the endpoint
// its speaker's voice belongs to, is measured as it will be spoken — after the dictionary, with the
// endpoint's tags written in, with the instructions sent beside it, in as many requests as the
// endpoint's limit cuts it into — and each endpoint's lines are priced together on its own card, at
// the **undiscounted** price, because a run lasts long enough for a promotion to end inside it
// (`~/usage/budget`). A line with no voice, or whose voice's endpoint is gone, is refused by the
// provider before any request, so it holds nothing.
//
// The same figure is held twice: whole, before anything is queued, to refuse a run that does not
// fit; and line by line while the job runs, released as each line settles, so the job's check
// before its next line does not count again what has already been spent.
import type {
  BillableUnits,
  Character,
  CharacterVoice,
  Endpoint,
  LexEntry,
  Segment,
} from "@/types";
import { NARRATOR, speakerVoice } from "@/lib/cast";
import { billingOf } from "@/lib/endpoints";
import { expressionPlan, type ExpressionPlan } from "@/lib/expressions";
import { plannedSpeechUnits, worstCaseOf } from "@/lib/narrationCost";
import { addUnits, estimateSpeech, noUnits, readPricing } from "@/lib/pricing";
import { speechInstructions } from "@/lib/speech";
import { readCast, readLexicon } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { readEndpoint } from "~/db/endpoints";
import { getBook } from "~/db/library";

/** Everything a clip records about how it was asked for, so drift can compare the line to it later. */
export interface Delivery {
  voiceRef: string | null;
  voice: string | null;
  endpoint: string | null;
  style: string;
}

/**
 * Who says a line, and how: the voice `speakerVoice` gives the speaker — their own, the book's
 * Character voice, or the Narrator's — and the speaker's own style; the cast store's
 * `effectiveVoice`, over the cast as it was read.
 */
export function deliveryFor(
  cast: Character[],
  characterVoice?: CharacterVoice,
): (speaker: string) => Delivery {
  const narratorVoice = cast.find((c) => c.name === NARRATOR)?.voice ?? null;
  return (speaker) => {
    const who = cast.find((c) => c.name === speaker);
    const voiceRef = speakerVoice(speaker, who, narratorVoice, characterVoice).ref;
    const slash = voiceRef?.indexOf("/") ?? -1;
    return {
      voiceRef,
      voice: voiceRef ? voiceRef.slice(slash + 1) : null,
      endpoint: voiceRef && slash > 0 ? voiceRef.slice(0, slash) : null,
      style: who?.style ?? "",
    };
  };
}

/**
 * What the budget holds for one line sent to `ep` as `plan`, at `at`: its undiscounted price on
 * the endpoint's card. Nothing for a line with no endpoint, which never reaches the wire.
 */
export function lineWorstCase(
  ep: Endpoint | undefined,
  plan: ExpressionPlan,
  instructions: string,
  at: number,
): number {
  if (!ep) return 0;
  const units = plannedSpeechUnits(plan, ep, instructions);
  return worstCaseOf(estimateSpeech(billingOf(ep), readPricing(ep), units, at));
}

/** What a chapter's lines are held at, and what they are expected to cost, in USD. */
export interface NarrationCost {
  /** the undiscounted worst case, which the cap is checked against and the job holds */
  reserved: number;
  /** at the rates in force now, for the reconciliation the Queue shows afterwards */
  estimated: number;
  estimatedInput: number;
  /** null when no endpoint in the run bills on the audio it returns */
  estimatedAudio: number | null;
  /**
   * The first line each endpoint is sent, at its worst case: what that endpoint's daily limit must
   * cover for the run to start (`~/usage/budget`).
   */
  firsts: { endpoint: string; cost: number }[];
}

/**
 * What rendering `segs` of `bookId` would cost, grouped per endpoint as the browser's estimate
 * groups it, so the figure the gate holds is the figure the estimate panel shows.
 */
/** `deliveryFor` over a book as it stands: its cast and its Character voice, read now. */
export function bookDelivery(db: Db | Tx, bookId: string): (speaker: string) => Delivery {
  return deliveryFor(readCast(db, bookId), getBook(db, bookId)?.characterVoice);
}

export function narrationCost(
  db: Db | Tx,
  bookId: string,
  segs: readonly Segment[],
  at: number = Date.now(),
): NarrationCost {
  const deliveryOf = bookDelivery(db, bookId);
  const lexicon: LexEntry[] = readLexicon(db, bookId);
  const endpoints = new Map<string, Endpoint | undefined>();
  const per = new Map<string, { ep: Endpoint; units: BillableUnits }>();
  const firsts: NarrationCost["firsts"] = [];
  for (const s of segs) {
    const who = deliveryOf(s.speaker);
    if (!who.endpoint) continue;
    if (!endpoints.has(who.endpoint)) endpoints.set(who.endpoint, readEndpoint(db, who.endpoint));
    const ep = endpoints.get(who.endpoint);
    if (!ep) continue;
    const plan = expressionPlan(s, ep, lexicon);
    const instructions = speechInstructions({ style: who.style, direction: s.direction });
    const units = plannedSpeechUnits(plan, ep, instructions);
    if (!per.has(ep.id))
      firsts.push({ endpoint: ep.id, cost: lineWorstCase(ep, plan, instructions, at) });
    const group = per.get(ep.id) ?? { ep, units: noUnits() };
    group.units = addUnits(group.units, units);
    per.set(ep.id, group);
  }
  const cost: NarrationCost = {
    reserved: 0,
    estimated: 0,
    estimatedInput: 0,
    estimatedAudio: null,
    firsts,
  };
  for (const { ep, units } of per.values()) {
    const priced = estimateSpeech(billingOf(ep), readPricing(ep), units, at);
    cost.reserved += worstCaseOf(priced);
    cost.estimated += priced.cost ?? 0;
    cost.estimatedInput += priced.inputCost ?? 0;
    if (priced.audioCost != null)
      cost.estimatedAudio = (cost.estimatedAudio ?? 0) + priced.audioCost;
  }
  return cost;
}
