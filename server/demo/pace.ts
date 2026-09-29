// How long a build in the demo takes: as long as one in the browser's demo does.
//
// The demo's clips are short tones and the stitcher joins them in a blink, so a build there would
// be finished before anyone could see it running — the "one running now" a situation asks for
// included. Its speech endpoints are held to their latency for the same reason
// (`providers/simulatedSpeech.ts`). The encoder is where a build's time goes, and it is handed to
// a library rather than reached for, so this is the demo's encoder: the same files, written at
// once, and each chapter told to the build at the pace of the browser's build simulator, which is
// what moves the Queue's count and the Audiobooks tab's bar. A cancel cuts the wait short.
import type { EncodedChapter, EncoderChoice } from "~/providers/encoder";
import { sleep } from "~/providers/fake";

/** How long each chapter takes: one tick of the browser's build simulator (`mock/simulators/build.ts`). */
export const CHAPTER_MS = 140;

/** `inner`, telling each chapter it writes to the build `chapterMs` after the one before. */
export function pacedEncoders(inner: EncoderChoice, chapterMs = CHAPTER_MS): EncoderChoice {
  return {
    name: inner.name,
    for(settings) {
      const encoder = inner.for(settings);
      return {
        ...encoder,
        async encode(input) {
          const landed: [EncodedChapter, number][] = [];
          const file = await encoder.encode({
            ...input,
            onChapter: (chapter, index) => void landed.push([chapter, index]),
          });
          for (const [chapter, index] of landed) {
            await sleep(chapterMs, input.signal);
            input.onChapter?.(chapter, index);
          }
          return file;
        },
      };
    },
  };
}
