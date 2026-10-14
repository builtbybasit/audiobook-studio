// The real speech provider: each line goes to its voice's endpoint, through the wire module its
// base URL speaks (`speech/`; anything unknown is OpenAI's `/audio/speech`). A line with no voice,
// no endpoint, no key or an unaskable format fails before any request and reports nothing.
// A simulated endpoint is answered here (`simulatedSpeech.ts`) and never batches.
import { isSimulated } from "@/lib/providers";
import type { EndpointProbe } from "@/types";
import { refuseEncoding } from "~/providers/answer";
import { ProviderError, requireKey } from "~/providers/http";
import { sendSpeech, type SpeechCallOptions } from "~/providers/send";
import { probeSimulated, speakSimulated } from "~/providers/simulatedSpeech";
import { wireOf } from "~/providers/speech/registry";
import type {
  BatchLimits,
  RenderedClip,
  SpeechBatch,
  SpeechInput,
  SpeechProvider,
} from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";

/** How long batch limits are cached. */
const LIMITS_KEPT_MS = 5 * 60_000;

const limitsKey = (t: ProviderTarget): string =>
  `${t.baseUrl}\n${t.model.trim()}\n${t.apiKey ? "key" : ""}`;

/** `<endpointId>/<voiceId>` → `<voiceId>`. */
const voiceIdOf = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

/** Throws a pre-request refusal: no voice, no endpoint, no key (unless simulated), bad format. */
function destination(
  input: SpeechInput,
  target: ProviderTarget | null,
): { target: ProviderTarget; voice: string } {
  const { voiceRef } = input;
  const voice = voiceRef ? voiceIdOf(voiceRef) : "";
  if (!voice)
    throw new ProviderError(
      `${input.speaker} has no voice to speak with. Cast one on the book's Cast page.`,
      0,
      false,
    );
  if (!target)
    throw new ProviderError(
      `${input.speaker}'s voice belongs to an endpoint that is no longer configured ` +
        `(${voiceRef}). Recast the speaker, or add the endpoint back on the Endpoints page.`,
      0,
      false,
    );
  if (!isSimulated(target.baseUrl)) requireKey(target);
  refuseEncoding(target, input);
  return { target, voice };
}

export interface EndpointSpeechOptions extends SpeechCallOptions {
  /** for a simulated endpoint's failures; `Math.random` unless a test picks */
  random?: () => number;
}

export function endpointSpeechProvider(options: EndpointSpeechOptions = {}): SpeechProvider {
  const { random = Math.random, ...calls } = options;
  const limits = new Map<string, { at: number; limits: BatchLimits | null }>();

  return {
    name: "Speech endpoints",

    async speak(input: SpeechInput): Promise<RenderedClip> {
      if (input.signal.aborted) throw input.signal.reason;
      const { target, voice } = destination(input, input.target);
      if (isSimulated(target.baseUrl)) return speakSimulated(input, target, voice, random);
      const { shape, wire } = wireOf(target);
      const request = wire.request(input, target, voice);
      const started = Date.now();
      const audio = await sendSpeech(input, target, request, {
        ...calls,
        billsFailures: shape.billsFailures,
      });
      return { ...audio, ms: Date.now() - started, model: target.model, voice };
    },

    async batchLimits(
      target: ProviderTarget,
      signal: AbortSignal,
      fresh = false,
    ): Promise<BatchLimits | null> {
      if (isSimulated(target.baseUrl)) return null;
      const { wire } = wireOf(target);
      if (!wire.batchLimits) return null;
      const key = limitsKey(target);
      const kept = limits.get(key);
      if (!fresh && kept && Date.now() - kept.at < LIMITS_KEPT_MS) return kept.limits;
      // a failure to ask is thrown, not cached: the job takes it as no batches for now
      requireKey(target);
      const answer = await wire.batchLimits(target, signal, calls);
      limits.set(key, { at: Date.now(), limits: answer });
      return answer;
    },

    async speakBatch(batch: SpeechBatch): Promise<void> {
      if (batch.signal.aborted) throw batch.signal.reason;
      const { target } = batch;
      const wired = isSimulated(target.baseUrl) ? null : wireOf(target);
      if (!wired?.wire.speakBatch)
        throw new ProviderError(`${target.name} does not take lines in batches`, 0, false);
      // an item refused before sending is answered now, and never sent
      const sending: number[] = [];
      const voices: string[] = [];
      batch.items.forEach((input, i) => {
        let voice: string;
        try {
          ({ voice } = destination(input, target));
        } catch (e) {
          batch.answered(i, { error: e as Error });
          return;
        }
        sending.push(i);
        voices.push(voice);
      });
      if (!sending.length) return;
      await wired.wire.speakBatch(
        {
          ...batch,
          items: sending.map((i) => batch.items[i]),
          answered: (j, outcome) => batch.answered(sending[j], outcome),
        },
        voices,
        { ...calls, billsFailures: wired.shape.billsFailures },
      );
    },

    async probe(target: ProviderTarget, signal: AbortSignal): Promise<EndpointProbe> {
      if (isSimulated(target.baseUrl)) return probeSimulated();
      // one attempt, so a dead endpoint says so at once
      const once = { ...target, maxRetries: 0 };
      let started = 0;
      try {
        requireKey(once);
        started = Date.now();
        return await wireOf(once).wire.probe(once, signal, calls);
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
          // 0 when it was refused before any request
          ms: started ? Date.now() - started : 0,
        };
      }
    },
  };
}
