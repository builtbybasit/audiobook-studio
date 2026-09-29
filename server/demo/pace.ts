// How long the demo's simulated work takes: as long as the browser's demo took, divided by the
// speed the Demo drawer is set to.
//
// The demo's clips are short tones and the stitcher joins them in a blink, so a build there would
// be finished before anyone could see it running — the "one running now" a situation asks for
// included. Its speech endpoints are held to their latency for the same reason
// (`providers/simulatedSpeech.ts`). The encoder is where a build's time goes, and it is handed to
// a library rather than reached for, so this is the demo's encoder: the same files, written at
// once, and each chapter told to the build at a pace a person can watch, which is what moves the Queue's count and the Audiobooks tab's bar. A cancel cuts the wait short.
//
// A tester watching a 214-chapter build has no use for that realism, so every one of those waits —
// a simulated line's, a simulated chunk's, a build's chapter — is divided by one `Pace` the demo
// library owns and the drawer sets (`routes/demo.ts`). Only the demo is paced: the real library is
// never handed one, so nothing about its runs can be sped up or slowed down. A run already going
// picks a new speed up at its next request or chapter. What a request records is the time it took,
// so at 16× the ledger's latencies are a sixteenth of the endpoint's.
import type { EncodedChapter, EncoderChoice } from "~/providers/encoder";
import { sleep } from "~/providers/fake";
import type { Providers, ProviderTarget } from "~/providers/target";

/** How long each chapter takes at 1×: the pace the demo's builds were always shown at. */
export const CHAPTER_MS = 140;

/**
 * How much faster than 1× the demo's simulated waits run: one of `SPEEDS`. Kept in memory, so a
 * server that starts again starts at 1×; a reset or a situation leaves it, since it is the tester's
 * setting rather than part of the world.
 */
export interface Pace {
  speed: number;
}

export const newPace = (): Pace => ({ speed: 1 });

/** `inner`, telling each chapter it writes to the build `chapterMs` at 1× after the one before. */
export function pacedEncoders(
  inner: EncoderChoice,
  pace: Pace,
  chapterMs = CHAPTER_MS,
): EncoderChoice {
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
            await sleep(chapterMs / pace.speed, input.signal);
            input.onChapter?.(chapter, index);
          }
          return file;
        },
      };
    },
  };
}

/** A simulated target with its latency divided by the speed; any other target as it is. */
function quicker<T extends ProviderTarget>(target: T | null, pace: Pace): T | null {
  const simulation = target?.simulation;
  if (!target || !simulation) return target;
  return { ...target, simulation: { ...simulation, latencyMs: simulation.latencyMs / pace.speed } };
}

/**
 * `inner`, with every line and every chunk a job sends to a simulated endpoint answered at the
 * speed. The target is where a simulated endpoint's latency travels (`providers/target.ts`), so
 * dividing it on the way in paces whichever provider answers it, the endpoints' own or a test's.
 */
export function pacedProviders(inner: Providers, pace: Pace): Providers {
  const { scripting, speech } = inner;
  return {
    ...inner,
    scripting: {
      ...scripting,
      script: (input) => scripting.script({ ...input, target: quicker(input.target, pace) }),
    },
    speech: {
      ...speech,
      speak: (input) => speech.speak({ ...input, target: quicker(input.target, pace) }),
    },
  };
}
