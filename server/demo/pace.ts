// Paces the demo's simulated work so a person can watch it: demo builds encode tones in a blink,
// so each chapter is reported at `CHAPTER_MS`. Every simulated wait is divided by the `Pace` the
// Demo drawer sets (`routes/demo.ts`); a running job picks up a new speed at its next request.
import type { EncoderChoice } from "~/providers/encoder";
import { sleep } from "~/providers/fake";
import type { Providers, ProviderTarget } from "~/providers/target";

/** Per chapter at 1×. */
export const CHAPTER_MS = 140;

/** One of `SPEEDS`. In memory only; a reset leaves it, as it is the tester's setting. */
export interface Pace {
  speed: number;
}

export const newPace = (): Pace => ({ speed: 1 });

/** Encodes at once, then reports each chapter `chapterMs` (at 1×) after the one before. */
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
          const landed: number[] = [];
          const file = await encoder.encode({
            ...input,
            onChapter: (index) => void landed.push(index),
          });
          for (const index of landed) {
            await sleep(chapterMs / pace.speed, input.signal);
            input.onChapter?.(index);
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

/** Divides a simulated target's latency (`providers/target.ts`) on the way in. */
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
