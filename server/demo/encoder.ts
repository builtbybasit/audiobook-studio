// The demo's encoder: really encodes only the first few seconds (format, cover, tags), but reports
// durations and chapter marks counted off every clip, so a build lands like a real one without
// minutes of ffmpeg. Pacing is `pace.ts`.
import { formatOfFile } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import type { EncodedChapter, EncodePart, EncoderChoice } from "~/providers/encoder";

const SAMPLE_SECONDS = 5;

async function secondsOf(part: EncodePart): Promise<number> {
  if (part.kind === "silence") return part.seconds;
  const bytes = await Bun.file(part.path).bytes();
  return (await probeClip(bytes, formatOfFile(part.path) ?? "wav")).duration;
}

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
            onMeasured: undefined,
          });
          if (encoder.normalizes) chapters.forEach((_, i) => input.onMeasured?.(i));
          chapters.forEach((c, i) => input.onChapter?.(c, i));
          return { ...written, seconds: at, chapters };
        },
      };
    },
  };
}
