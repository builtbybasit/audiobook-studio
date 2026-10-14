// A simulated speech endpoint (`simulated://…`), answered here with the fake's tone at the
// endpoint's `latency` and `failRate`. Its made-up failures are retryable and unbilled; the chance
// is injectable. It takes one line at a time, and has nothing to clone or search.
import { SIMULATED_VOICES } from "@/lib/providers";
import type { EndpointProbe, VoiceListPage } from "@/types";
import { sleep } from "~/providers/fake";
import { speakTone } from "~/providers/fakeSpeech";
import { ProviderError } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import { onePage } from "~/providers/speech/wire";
import type { ProviderTarget } from "~/providers/target";

export async function speakSimulated(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  random: () => number,
): Promise<RenderedClip> {
  const { latencyMs, failRate } = target.simulation ?? { latencyMs: 0, failRate: 0 };
  const started = Date.now();
  if (latencyMs) await sleep(latencyMs, input.signal);
  if (input.signal.aborted) throw input.signal.reason;
  // a 500, so it is retried like a real one
  const failure =
    random() < failRate
      ? new ProviderError(
          `${target.name} failed this line on purpose: it fails ${Math.round(failRate * 100)}% of them`,
          500,
          true,
        )
      : undefined;
  const audio = speakTone(input, started, failure);
  return { ...audio, ms: Date.now() - started, model: target.model, voice };
}

export const probeSimulated = (): EndpointProbe => ({
  ok: true,
  message: "Simulated: answered here, without a request",
  ms: 0,
});

export const simulatedVoices = (): VoiceListPage => onePage([...SIMULATED_VOICES]);
