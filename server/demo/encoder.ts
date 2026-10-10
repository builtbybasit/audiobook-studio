// The demo's encoder: a build that runs and lands like a real one, without encoding hours of audio.
//
// The demo's books run to hundreds of chapters of tones, and ffmpeg would spend minutes of a
// machine on each build of one — a build a tester only wants to watch move through the Queue. So,
// as a Simulated endpoint answers a line here rather than at a provider, the demo's builds write a
// sample: the book's first few seconds, encoded for real by the encoder the settings ask for — its
// format, cover and tags — while what the export says it holds, how long it plays and where each
// chapter falls, is counted off every clip it would have encoded. The pace a person can watch it
// at is `pace.ts`'s.
import { formatOfFile } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import type { EncodedChapter, EncodePart, EncoderChoice } from "~/providers/encoder";

/** How much of the book a demo build really encodes. */
const SAMPLE_SECONDS = 5;

/** How long a part plays: a clip by its file, silence by its length. */
async function secondsOf(part: EncodePart): Promise<number> {
  if (part.kind === "silence") return part.seconds;
  const bytes = await Bun.file(part.path).bytes();
  return (await probeClip(bytes, formatOfFile(part.path) ?? "wav")).duration;
}

/** `inner`, writing a sample of each file and the whole of its account. */
export function simulatedEncoders(inner: EncoderChoice): EncoderChoice {
  return {
    name: `${inner.name}, a sample of each file`,
    for(settings) {
      const encoder = inner.for(settings);
      return {
        ...encoder,
        async encode(input) {
          const chapters: EncodedChapter[] = [];
          const sample: EncodePart[] = [];
          let sampled = 0;
          let at = 0;
          for (const [i, chapter] of input.chapters.entries()) {
            if (i > 0) at += input.gap;
            let seconds = 0;
            for (const part of chapter.parts) {
              const plays = await secondsOf(part);
              seconds += plays;
              if (sampled < SAMPLE_SECONDS && (part.kind === "clip" || sample.length)) {
                sample.push(part);
                sampled += plays;
              }
            }
            chapters.push({
              id: chapter.id,
              start: Math.round(at * 1000),
              length: Math.round(seconds * 1000),
              seconds,
            });
            at += seconds;
          }
          const first = input.chapters[0];
          const written = await encoder.encode({
            ...input,
            chapters: [{ id: first.id, title: first.title, parts: sample }],
            onChapter: undefined,
          });
          chapters.forEach((c, i) => input.onChapter?.(c, i));
          return { ...written, seconds: at, chapters };
        },
      };
    },
  };
}
