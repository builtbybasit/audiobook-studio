// The real speech provider: each line sent to the endpoint its voice belongs to.
//
// Which endpoint that is, and its key, the job has already decided and hands over as the line's
// `target` — this module only picks the wire shape, from the base URL. Fish Audio's gets Fish's own
// request (`fishSpeech.ts`), Google's Gemini API its `generateContent` (`geminiSpeech.ts`),
// ElevenLabs' and BreezeBlue's theirs (`elevenLabsSpeech.ts`), MiniMax, Cartesia
// and Alibaba's Qwen their own (`miniMaxSpeech.ts`, `cartesiaSpeech.ts`, `qwenSpeech.ts`); every other base URL is taken to speak OpenAI's
// `/audio/speech` (`openaiSpeech.ts`), which is what the compatible local servers copy. Both answer in the format
// the endpoint asks for (`answer.ts`): a WAV rewritten under a plain header, its duration counted
// from its samples (`wav.ts`), or an MP3 or Opus file kept as it came, its duration read from it.
//
// A line with nowhere to go fails with the reason rather than going somewhere nobody chose: a
// speaker with no voice, a voice whose endpoint has been deleted, an endpoint that needs a key and
// has none. All three are refused before a request, so none of them costs anything, and none is
// reported through `sent`: the ledger records requests that happened (`sent.ts`).
import {
  isCartesia,
  isElevenLabsShaped,
  isFishAudio,
  isGemini,
  isMiniMax,
  isQwen,
} from "@/lib/endpointShapes";
import { ProviderError, requireKey } from "~/providers/http";
import { cartesiaProbe, cartesiaSpeak } from "~/providers/cartesiaSpeech";
import { elevenLabsProbe, elevenLabsSpeak } from "~/providers/elevenLabsSpeech";
import { fishProbe, fishSpeak, type SpeechCallOptions } from "~/providers/fishSpeech";
import { geminiProbe, geminiSpeak } from "~/providers/geminiSpeech";
import { miniMaxProbe, miniMaxSpeak } from "~/providers/miniMaxSpeech";
import { openaiProbe, openaiSpeak } from "~/providers/openaiSpeech";
import { qwenProbe, qwenSpeak } from "~/providers/qwenSpeech";
import type { RenderedClip, SpeechInput, SpeechProvider } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

/** The voice's own id, after the endpoint's in `<endpointId>/<voiceId>`. */
const voiceIdOf = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

export function endpointSpeechProvider(options: SpeechCallOptions = {}): SpeechProvider {
  return {
    name: "Speech endpoints",

    async speak(input: SpeechInput): Promise<RenderedClip> {
      if (input.signal.aborted) throw input.signal.reason;
      const { target, voiceRef } = input;
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
      requireKey(target);
      if (isFishAudio(target)) return fishSpeak(input, target, voice, options);
      if (isGemini(target)) return geminiSpeak(input, target, voice, options);
      if (isElevenLabsShaped(target)) return elevenLabsSpeak(input, target, voice, options);
      if (isMiniMax(target)) return miniMaxSpeak(input, target, voice, options);
      if (isCartesia(target)) return cartesiaSpeak(input, target, voice, options);
      if (isQwen(target)) return qwenSpeak(input, target, voice, options);
      return openaiSpeak(input, target, voice, options);
    },

    async probe(target: ProviderTarget, signal: AbortSignal): Promise<ProbeResult> {
      // A test is a question, not a job: one attempt, so a dead endpoint says so at once.
      const once = { ...target, maxRetries: 0 };
      let started = 0;
      try {
        requireKey(once);
        started = Date.now();
        const probe = isFishAudio(once)
          ? fishProbe
          : isGemini(once)
            ? geminiProbe
            : isElevenLabsShaped(once)
              ? elevenLabsProbe
              : isMiniMax(once)
                ? miniMaxProbe
                : isCartesia(once)
                  ? cartesiaProbe
                  : isQwen(once)
                    ? qwenProbe
                    : openaiProbe;
        return await probe(once, signal, options);
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
