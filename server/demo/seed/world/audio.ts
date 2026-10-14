// Seeded clips carry the audit trail a real run leaves (voice, model, text as sent, dictionary
// changes): staleness, drift and loudness are decided from it.
import { splitText } from "@/lib/split";
import { speak, chapterSeconds, speechInstructions, DEFAULT_PACING } from "@/lib/speech";
import { billingOf } from "@/lib/endpoints";
import { PRICING_RULE, measureSpeech, priceSpeechRequest, readPricing } from "@/lib/pricing";
import { generateSegments } from "~/demo/seed/world/script";
import type { WorldDraft } from "~/demo/seed/world/draft";
import type { Book, Endpoint, Segment, SegmentAudio, VoiceRef } from "@/types";

/** What seeding a clip must agree with; a world draft and a scenario's context both satisfy it. */
export type ClipWorld = Pick<WorldDraft, "characters" | "lexicon" | "endpoints">;

/** rendered length of a chapter: the clips it plays plus the silence stitched between them */
export const timeOf = (segs: Segment[], book: Pick<Book, "readNotes"> | undefined): number =>
  chapterSeconds(segs, DEFAULT_PACING, book);

const seedCuts = (text: string, ep: Endpoint) => {
  const cuts = splitText(text, ep.maxChars, ep.splitAt);
  return cuts.length > 1
    ? {
        parts: cuts.length,
        splitAt: ep.splitAt,
        cuts: cuts.map((c) => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback })),
      }
    : {};
};

export const seedAudit = (
  w: ClipWorld,
  bookId: string,
  s: Segment,
  ep: Endpoint,
  i: number,
  now: number,
) => {
  const cast = w.characters[bookId];
  const c = cast.find((x) => x.name === s.speaker);
  const ref = (c?.voice || cast.find((x) => x.name === "Narrator")!.voice)!;
  const said = speak(s.text, w.lexicon[bookId] ?? []);
  const instructions = speechInstructions({ style: c?.style, direction: s.direction });
  const at = now - (3600 + i * 7) * 1000;
  // priced by the shared engine in the endpoint's own billing model, so seeded costs agree
  const billing = billingOf(ep);
  const charge = priceSpeechRequest(
    billing,
    readPricing(ep),
    measureSpeech(
      {
        text: said.text,
        instructions,
        requests: Math.max(1, splitText(said.text, ep.maxChars, ep.splitAt).length),
        audioSeconds: s.text.split(" ").length / 2.6,
      },
      billing,
    ),
    { at, rule: PRICING_RULE },
  );
  return {
    voiceRef: ref,
    voice: ref.split("/")[1],
    model: ep.model,
    direction: s.direction,
    style: c?.style ?? "",
    ...(instructions ? { instructions } : {}),
    type: s.type,
    text: s.text,
    ...(said.hits.length ? { said: said.text, lex: said.hits.length } : {}),
    at,
    charge,
    ...(charge.amount != null ? { cost: charge.amount } : {}),
  };
};

/** One finished clip with audit trail and cut preview; scenarios use it too. */
export const seedClip = (
  w: ClipWorld,
  bookId: string,
  s: Segment,
  ep: Endpoint,
  i: number,
  now: number,
): SegmentAudio => ({
  status: "done",
  endpoint: ep.id,
  ms: 900 + i * 37,
  duration: s.text.split(" ").length / 2.6,
  ...seedCuts(s.text, ep),
  ...seedAudit(w, bookId, s, ep, i, now),
});

/** The voice a speaker is read in, falling back to the Narrator's. */
export const refOf = (w: ClipWorld, bookId: string, speaker: string): VoiceRef => {
  const cast = w.characters[bookId];
  return (cast.find((c) => c.name === speaker)?.voice ||
    cast.find((c) => c.name === "Narrator")!.voice)!;
};

/** The endpoint that owns that voice. */
export const routeOf = (w: ClipWorld, bookId: string, speaker: string): Endpoint => {
  const ref = refOf(w, bookId, speaker);
  return w.endpoints.find((e) => e.id === ref.split("/")[0])!;
};

/**
 * Chapters 1..`scripted` get a script, 1..`narrated` clips. `light` skips the split preview and
 * audit trail (6,000-odd clips in a 214-chapter serial) but keeps each clip's voice.
 */
export function seedPipeline(
  w: WorldDraft,
  bookId: string,
  scripted: number,
  narrated: number,
  now: number,
  light = false,
): void {
  for (const c of w.chapters[bookId]) {
    if (c.id <= scripted) {
      c.scripting = "done";
      c.scriptingProgress = 100;
      w.segments[`${bookId}:${c.id}`] = generateSegments(bookId, c.id);
    }
    if (c.id <= narrated) {
      c.narration = "done";
      c.narrationProgress = 100;
      const segs = w.segments[`${bookId}:${c.id}`];
      segs.forEach((s, i) => {
        const ep = routeOf(w, bookId, s.speaker);
        s.audio = light
          ? {
              status: "done",
              endpoint: ep.id,
              ms: 900 + i * 37,
              duration: s.text.split(" ").length / 2.6,
              voiceRef: refOf(w, bookId, s.speaker),
              model: ep.model,
              type: s.type,
              text: s.text,
              at: now - (86400 + c.id * 61 + i * 7) * 1000,
            }
          : seedClip(w, bookId, s, ep, i, now);
      });
      c.duration = timeOf(
        segs,
        w.books.find((b) => b.id === bookId),
      );
    }
  }
}
