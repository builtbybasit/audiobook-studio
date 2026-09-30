// The real speech provider: each line sent to the endpoint its voice belongs to.
//
// Which endpoint that is, and its key, the job has already decided and hands over as the line's
// `target` — this module only finds which provider the base URL speaks (`lib/providers/`) and
// hands the line to that provider's wire module (`speech/`), which knows its request, its answer
// and its Test button. Every other base URL is taken to speak OpenAI's `/audio/speech`, which is
// what the compatible local servers copy. Whatever the provider, the line is held to the formats
// it can be asked for before anything is built (`refuseEncoding`), and sent, read and reported to
// the ledger the same way (`send.ts`).
//
// A line with nowhere to go fails with the reason rather than going somewhere nobody chose: a
// speaker with no voice, a voice whose endpoint has been deleted, an endpoint that needs a key and
// has none. All three are refused before a request, so none of them costs anything, and none is
// reported through `sent`: the ledger records requests that happened (`sent.ts`).
//
// A simulated endpoint (`simulated://…`) is answered here, after the same refusals less the key,
// which it never needs: a tone at the endpoint's rate, as slow and as unreliable as it is set to be
// (`simulatedSpeech.ts`). Nothing is sent for it, so it is never asked about batches or given one.
//
// Batches go the same way. Whether an endpoint takes them is its wire's question — only a server
// that speaks the batch speech API does, through the compatible wire (`speech/batch.ts`) — and the
// answer is remembered here for a few minutes, so a run that asks before every chapter asks the
// server once. Each item of a batch is held to the same refusals a line is, and one that fails
// them is answered with the reason and never sent; the rest go in one request.
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

/** How long what an endpoint said about batches is believed before it is asked again. */
const LIMITS_KEPT_MS = 5 * 60_000;

/** What a batch answer is remembered by: the server, the model, and whether a key was sent. */
const limitsKey = (t: ProviderTarget): string =>
  `${t.baseUrl}\n${t.model.trim()}\n${t.apiKey ? "key" : ""}`;

/** The voice's own id, after the endpoint's in `<endpointId>/<voiceId>`. */
const voiceIdOf = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

/**
 * Where a line goes and with which voice, once it has passed every refusal made before a request —
 * no voice, no endpoint, no key (unless it is simulated), a format the endpoint's API cannot be
 * asked for. Throws the reason otherwise.
 */
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
  /** the chance a simulated endpoint's failures are drawn from; `Math.random` unless a test picks */
  random?: () => number;
}

export function endpointSpeechProvider(options: EndpointSpeechOptions = {}): SpeechProvider {
  const { random = Math.random, ...calls } = options;
  /** what each endpoint said about batches, and when; keyed by where it was asked and how */
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

    async batchLimits(target: ProviderTarget, signal: AbortSignal): Promise<BatchLimits | null> {
      if (isSimulated(target.baseUrl)) return null;
      const { wire } = wireOf(target);
      if (!wire.batchLimits) return null;
      const key = limitsKey(target);
      const kept = limits.get(key);
      if (kept && Date.now() - kept.at < LIMITS_KEPT_MS) return kept.limits;
      // A failure to ask — no answer, a refused key — is thrown and not kept: the job takes it as
      // no batches for now, and the next time it asks, the server is asked again.
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
      // each item held to what a line is held to; one refused is answered now, and never sent
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
      // A test is a question, not a job: one attempt, so a dead endpoint says so at once.
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
