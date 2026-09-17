// Rendered clips. Seeding narration means writing the same audit trail a real run would leave —
// the voice, the model, the text as sent and what the dictionary did to it — because staleness,
// drift and loudness are all decided from that trail rather than from a timestamp.
import { splitText } from "@/lib/split";
import { speak, silenceOf, speechInstructions, DEFAULT_PACING } from "@/lib/speech";
import { billingOf } from "@/lib/endpoints";
import { PRICING_RULE, measureSpeech, priceSpeechRequest, readPricing } from "@/lib/pricing";
import { generateSegments } from "@/mock/world/script";
import type { WorldDraft } from "@/mock/world/draft";
import type { Endpoint, Segment, SegmentAudio, VoiceRef } from "@/types";

/** What seeding a clip has to agree with: who reads the line, how the book says it, and where it
 *  is rendered. A world under construction satisfies this, and so does the live store — which is
 *  how a demo scenario seeds clips the same way the world did. */
export type ClipWorld = Pick<WorldDraft, "characters" | "lexicon" | "endpoints">;

/** rendered length of a chapter: the clips plus the silence stitched between them */
export const timeOf = (segs: Segment[]): number =>
  segs.reduce((a, s) => a + s.audio.duration, 0) + silenceOf(segs, DEFAULT_PACING);

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

export const seedAudit = (w: ClipWorld, bookId: string, s: Segment, ep: Endpoint, i: number) => {
  const cast = w.characters[bookId];
  const c = cast.find((x) => x.name === s.speaker);
  const ref = (c?.voice || cast.find((x) => x.name === "Narrator")!.voice)!;
  const said = speak(s.text, w.lexicon[bookId] ?? []);
  const instructions = speechInstructions({ style: c?.style, direction: s.direction });
  const at = Date.now() - (3600 + i * 7) * 1000;
  // Priced through the one engine every other request goes through, in this endpoint's own billing
  // model. The seeded world used to multiply the character count by a per-1M-characters number,
  // which silently priced a byte-billed or token-billed endpoint as though it billed characters —
  // so the opening balance disagreed with every figure the app worked out afterwards.
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

/** One finished clip, exactly as the seeded world writes it — audit trail, cut preview and all.
 *  A demo scenario that narrates a chapter after the fact goes through here, so a seeded clip and a
 *  world-seeded one are the same thing. */
export const seedClip = (
  w: ClipWorld,
  bookId: string,
  s: Segment,
  ep: Endpoint,
  i: number,
): SegmentAudio => ({
  status: "done",
  endpoint: ep.id,
  ms: 900 + i * 37,
  duration: s.text.split(" ").length / 2.6,
  ...seedCuts(s.text, ep),
  ...seedAudit(w, bookId, s, ep, i),
});

/** The voice a speaker is read in, falling back to the Narrator's. */
export const refOf = (w: ClipWorld, bookId: string, speaker: string): VoiceRef => {
  const cast = w.characters[bookId];
  return (cast.find((c) => c.name === speaker)?.voice ||
    cast.find((c) => c.name === "Narrator")!.voice)!;
};

/** The endpoint that owns that voice — the one a clip for this speaker would be rendered by. */
export const routeOf = (w: ClipWorld, bookId: string, speaker: string): Endpoint => {
  const ref = refOf(w, bookId, speaker);
  return w.endpoints.find((e) => e.id === ref.split("/")[0])!;
};

/**
 * Seed pipeline state so every screen has something to show: chapters 1..`scripted` have a script,
 * chapters 1..`narrated` have clips.
 *
 * `light` skips the per-clip split preview and audit trail: a 214-chapter serial is 6,000-odd clips,
 * and computing cut points for every one of them at start-up buys nothing the Export page reads.
 * The clips still carry the voice they were rendered with, which is what loudness and staleness are
 * decided from.
 */
export function seedPipeline(
  w: WorldDraft,
  bookId: string,
  scripted: number,
  narrated: number,
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
              at: Date.now() - (86400 + c.id * 61 + i * 7) * 1000,
            }
          : seedClip(w, bookId, s, ep, i);
      });
      c.duration = timeOf(segs);
    }
  }
}
