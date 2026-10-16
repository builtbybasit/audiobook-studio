// A line too long for its endpoint, or with a pause its voice has no tag for, sent as parts (one
// request after another, or as batch items, `batch.ts`) and joined into one clip.
import { FORMAT_LABEL } from "@/lib/endpointShapes";
import { joinedParts, type SplitPart } from "@/lib/split";
import { joinClips } from "~/audio/probe";
import { ProviderError } from "~/providers/http";
import type { RenderedClip, SpeechInput, SpeechProvider } from "~/providers/speech";

/** A cancel or a stop is thrown instead. */
export type Outcome = { rendered: RenderedClip } | { error: unknown };

/** `part` is 1-based, as the Queue shows it. */
export class PartFailed extends Error {
  constructor(
    readonly part: number,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The provider's status (for a split line, the failed part's), or 0 when nothing answered. */
export function failureCode(e: unknown): number {
  const cause = e instanceof PartFailed ? e.cause : e;
  return cause instanceof ProviderError ? cause.status : 0;
}

/** Out of credit: every line after it would fail the same, so the run stops with this reason. */
export function stopsRun(e: unknown): boolean {
  const cause = e instanceof PartFailed ? e.cause : e;
  return cause instanceof ProviderError && cause.outOfCredit;
}

/**
 * No silence between `maxChars` cuts: each part's audio carries its own breath. A cut for a pause
 * gets the pause's silence (`SplitPart.before`/`after`). A failed part fails the whole line.
 * Opus fails before sending: chained Ogg streams seek badly and time as their first stream.
 */
export async function speakInParts(
  provider: SpeechProvider,
  input: SpeechInput,
  cuts: SplitPart[] | null,
): Promise<RenderedClip> {
  if (!cuts || !joinedParts(cuts)) return provider.speak(input);
  if (input.encoding.format === "opus") throw opusInParts(cuts.length);
  const rendered: RenderedClip[] = [];
  for (const [i, cut] of cuts.entries()) {
    if (input.signal.aborted) throw input.signal.reason;
    try {
      // the whitespace a cut keeps for rejoining is not the provider's to read
      rendered.push(await provider.speak({ ...input, text: cut.text.trim() }));
    } catch (e) {
      if (input.signal.aborted) throw e;
      throw new PartFailed(i + 1, e);
    }
  }
  return joinParts(rendered, cuts);
}

export const opusInParts = (parts: number): Error =>
  new Error(
    parts > 1
      ? `This line needs ${parts} requests, at its endpoint's max characters or at a pause its voice has no tag for, and an Opus line cannot be split into parts; raise this endpoint's max characters or choose MP3 or WAV`
      : "This line has a pause its voice has no tag for, which is silence added to the clip, and an Opus clip cannot be added to; choose MP3 or WAV",
  );

/** Joins with the silence `cuts` puts around each part. */
export function joinParts(rendered: RenderedClip[], cuts?: readonly SplitPart[]): RenderedClip {
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
      rendered.flatMap((r, i) => [cuts?.[i]?.before ?? 0, r.bytes, cuts?.[i]?.after ?? 0]),
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
    duration:
      rendered.reduce((a, r) => a + r.duration, 0) +
      (cuts ?? []).reduce((a, c) => a + (c.before ?? 0) + (c.after ?? 0), 0),
    ms: rendered.reduce((a, r) => a + r.ms, 0),
    model: last.model,
    voice: last.voice,
  };
}
