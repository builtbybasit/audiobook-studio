// What narration will cost before it is sent, priced per endpoint at the **undiscounted** price,
// since a promotion can end mid-run (`~/usage/budget`). Held whole to refuse a run that does not
// fit, then line by line while the job runs, released as each line settles.
import type {
  BillableUnits,
  Character,
  CharacterVoice,
  Endpoint,
  LexEntry,
  Segment,
} from "@/types";
import { speakerVoice } from "@/lib/cast";
import { billingOf } from "@/lib/endpoints";
import { plannedSpeechUnits, worstCaseOf } from "@/lib/narrationCost";
import { addUnits, estimateSpeech, noUnits, readPricing } from "@/lib/pricing";
import { prepareReading, type ReadLine, type Reader, type Reading } from "@/lib/reading";
import { readCast, readLexicon } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { readEndpoint } from "~/db/endpoints";
import { getBook, readPacing } from "~/db/library";

/** What a clip records about how it was asked for, so drift can compare against it later. */
export interface Delivery {
  voiceRef: string | null;
  voice: string | null;
  endpoint: string | null;
  style: string;
  /** the speaker's own `Character.speed`, 1 when unset */
  speed: number;
}

/** The server's `effectiveVoice`: the voice `speakerVoice` gives, and the speaker's own style. */
export function deliveryFor(
  cast: Character[],
  characterVoice?: CharacterVoice,
): (speaker: string) => Delivery {
  // the first of a name wins, as `find` would
  const byName = new Map<string, Character>();
  for (const c of cast) if (!byName.has(c.name)) byName.set(c.name, c);
  return (speaker) => {
    const voiceRef = speakerVoice(speaker, byName, characterVoice).ref;
    const slash = voiceRef?.indexOf("/") ?? -1;
    return {
      voiceRef,
      voice: voiceRef ? voiceRef.slice(slash + 1) : null,
      endpoint: voiceRef && slash > 0 ? voiceRef.slice(0, slash) : null,
      style: byName.get(speaker)?.style ?? "",
      speed: byName.get(speaker)?.speed ?? 1,
    };
  };
}

const readerOf = (db: Db | Tx, who: Delivery): Reader => ({
  endpoint: who.endpoint ? readEndpoint(db, who.endpoint) : undefined,
  voiceRef: who.voiceRef,
  style: who.style,
  speed: who.speed,
});

/** A line's reading (`@/lib/reading`) against what is stored now. */
export function lineReading(db: Db | Tx, bookId: string, s: ReadLine, who: Delivery): Reading {
  return prepareReading(s, readerOf(db, who), readLexicon(db, bookId), readPacing(db, bookId));
}

/** Undiscounted; 0 for a line with no endpoint, which never reaches the wire. */
export function lineWorstCase(reading: Reading, at: number): number {
  const ep = reading.reader.endpoint;
  if (!ep) return 0;
  const units = plannedSpeechUnits(reading, ep);
  return worstCaseOf(estimateSpeech(billingOf(ep), readPricing(ep), units, at));
}

/** USD. */
export interface NarrationCost {
  /** the undiscounted worst case the cap is checked against */
  reserved: number;
  /** at current rates, for the Queue's reconciliation afterwards */
  estimated: number;
  estimatedInput: number;
  /** null when no endpoint in the run bills on the audio it returns */
  estimatedAudio: number | null;
  /** each endpoint's first line, which its daily limit must cover to start (`~/usage/budget`) */
  firsts: { endpoint: string; cost: number }[];
  /** false when a line's endpoint is gone or has no known price: `reserved` is then a floor */
  priced: boolean;
}

export function bookDelivery(db: Db | Tx, bookId: string): (speaker: string) => Delivery {
  return deliveryFor(readCast(db, bookId), getBook(db, bookId)?.characterVoice);
}

/**
 * `narrationCost` with the book's cast, dictionary and pacing read once, for pricing many chapters.
 * Grouped per endpoint as the browser's estimate is, so the gate holds what the panel shows.
 */
export function narrationPricer(
  db: Db | Tx,
  bookId: string,
  at: number = Date.now(),
): (segs: readonly Segment[]) => NarrationCost {
  const deliveryOf = bookDelivery(db, bookId);
  const lexicon: LexEntry[] = readLexicon(db, bookId);
  const pacing = readPacing(db, bookId);
  const endpoints = new Map<string, Endpoint | undefined>();
  return (segs) => {
    const per = new Map<string, { ep: Endpoint; units: BillableUnits }>();
    const firsts: NarrationCost["firsts"] = [];
    let priced = true;
    for (const s of segs) {
      const who = deliveryOf(s.speaker);
      if (!who.endpoint) continue;
      if (!endpoints.has(who.endpoint)) endpoints.set(who.endpoint, readEndpoint(db, who.endpoint));
      const ep = endpoints.get(who.endpoint);
      if (!ep) {
        priced = false;
        continue;
      }
      const reading = prepareReading(
        s,
        { endpoint: ep, voiceRef: who.voiceRef, style: who.style, speed: who.speed },
        lexicon,
        pacing,
      );
      const units = plannedSpeechUnits(reading, ep);
      if (!per.has(ep.id)) firsts.push({ endpoint: ep.id, cost: lineWorstCase(reading, at) });
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
      priced,
    };
    for (const { ep, units } of per.values()) {
      const est = estimateSpeech(billingOf(ep), readPricing(ep), units, at);
      if (est.cost == null) cost.priced = false;
      cost.reserved += worstCaseOf(est);
      cost.estimated += est.cost ?? 0;
      cost.estimatedInput += est.inputCost ?? 0;
      if (est.audioCost != null) cost.estimatedAudio = (cost.estimatedAudio ?? 0) + est.audioCost;
    }
    return cost;
  };
}

export const narrationCost = (
  db: Db | Tx,
  bookId: string,
  segs: readonly Segment[],
  at: number = Date.now(),
): NarrationCost => narrationPricer(db, bookId, at)(segs);
