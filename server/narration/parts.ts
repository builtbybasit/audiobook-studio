// A line too long for its endpoint, sent as parts and kept as one clip.
//
// The narration job sends a line whole when it fits the endpoint's `maxChars`, and otherwise as
// the parts its reading is cut into (`cutReading`) — one request after another, or each part an item of a
// batch (`batch.ts`) — and joins what comes back into one file. What a failed part, a part in the
// wrong format and an Opus line in parts come to is stated here, once, for both ways of sending.
import { FORMAT_LABEL } from "@/lib/endpointShapes";
import type { SplitPart } from "@/lib/split";
import { joinClips } from "~/audio/probe";
import { ProviderError } from "~/providers/http";
import type { RenderedClip, SpeechInput, SpeechProvider } from "~/providers/speech";

/** How a line's send ended; a cancel or a stop is thrown instead. */
export type Outcome = { rendered: RenderedClip } | { error: unknown };

/** One part of a split line that could not be rendered, by its place, as the Queue shows it. */
export class PartFailed extends Error {
  constructor(
    readonly part: number,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/**
 * The status a failed line's clip records: what the provider answered — for a split line, the part
 * that failed — or 0 when nothing did, so a 503 after its retries reads as the server's refusal
 * rather than as a line that was never sent.
 */
export function failureCode(e: unknown): number {
  const cause = e instanceof PartFailed ? e.cause : e;
  return cause instanceof ProviderError ? cause.status : 0;
}

/**
 * A line sent the way its endpoint will take it: whole, or — longer than its `maxChars` — as the
 * parts its reading is cut into (`cutReading`), one request after another, the audio joined into one file.
 *
 * Nothing goes between the parts. The cuts fall where the reading already pauses — a sentence's
 * end, then a clause's — and each request's audio carries its own breath at either end, so adding
 * silence would read as a pause the line never had. A part that fails fails the line, with its
 * number: the parts before it are thrown away rather than kept as half a line.
 *
 * WAV parts join as samples and MP3 parts as frames (`joinClips`). An Opus line that needs parts
 * fails before the first is sent: joined Opus is two Ogg streams chained in one file, which is
 * legal but which browsers seek badly and time as its first stream, so a line would play whole
 * and show a third of its length. Paying for parts that cannot be kept is worse than saying so.
 */
export async function speakInParts(
  provider: SpeechProvider,
  input: SpeechInput,
  cuts: SplitPart[] | null,
): Promise<RenderedClip> {
  if (!cuts || cuts.length < 2) return provider.speak(input);
  if (input.encoding.format === "opus") throw opusInParts(cuts.length);
  const rendered: RenderedClip[] = [];
  for (const [i, cut] of cuts.entries()) {
    if (input.signal.aborted) throw input.signal.reason;
    try {
      // the whitespace a cut keeps so the parts rejoin to the line is not the provider's to read
      rendered.push(await provider.speak({ ...input, text: cut.text.trim() }));
    } catch (e) {
      if (input.signal.aborted) throw e;
      throw new PartFailed(i + 1, e);
    }
  }
  return joinParts(rendered);
}

/** Why an Opus line cannot go in parts; see `speakInParts`. */
export const opusInParts = (parts: number): Error =>
  new Error(
    `This line needs ${parts} requests at its endpoint's max characters, and an Opus line cannot be split into parts; raise this endpoint's max characters or choose MP3 or WAV`,
  );

/** A line's parts, in order, as one clip: the audio joined end to end, the times summed. */
export function joinParts(rendered: RenderedClip[]): RenderedClip {
  const { format, mime } = rendered[0];
  let bytes: Uint8Array;
  try {
    const other = rendered.findIndex((r) => r.format !== format);
    if (other >= 0)
      throw new Error(
        `part ${other + 1} came back as ${FORMAT_LABEL[rendered[other].format]} and part 1 as ${FORMAT_LABEL[format]}`,
      );
    bytes = joinClips(
      format,
      rendered.map((r) => r.bytes),
    );
  } catch (e) {
    throw new Error(`The parts that came back could not be joined: ${(e as Error).message}`, {
      cause: e,
    });
  }
  const last = rendered.at(-1)!;
  return {
    bytes,
    format,
    mime,
    duration: rendered.reduce((a, r) => a + r.duration, 0),
    ms: rendered.reduce((a, r) => a + r.ms, 0),
    model: last.model,
    voice: last.voice,
  };
}
