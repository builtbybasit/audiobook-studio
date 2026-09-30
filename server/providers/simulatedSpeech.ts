// A simulated speech endpoint, answered on this server and never the network.
//
// An endpoint whose base URL is `simulated://…` (`lib/providers/simulated.ts`) has no wire: the
// real provider (`endpointSpeech.ts`) and the voice lister (`voices.ts`) come here instead of to
// the registry. A line is the fake's tone (`speakTone`), at the rate the endpoint asks for, named
// with the endpoint's model and reported as simulated — held to what the endpoint's `latency` and
// `failRate` say, so a run on one takes time and loses lines the way a run on a real endpoint can.
//
// A failure it makes up is a server's that could go differently next time: retryable, reported
// through `sent` as a request that failed and was not billed. Which lines fail is chance, and the
// chance is injectable, so a test says which. It takes one line at a time and has nothing to clone
// or search; its voices are the few it names.
import { SIMULATED_VOICES } from "@/lib/providers";
import type { EndpointProbe, VoiceListPage } from "@/types";
import { sleep } from "~/providers/fake";
import { speakTone } from "~/providers/fakeSpeech";
import { ProviderError } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import { onePage } from "~/providers/speech/wire";
import type { ProviderTarget } from "~/providers/target";

/**
 * `voice` said by a simulated endpoint: after its latency, which a cancel cuts short, and failed
 * when `random()` falls within its fail rate.
 */
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
  // what a server error is, so a simulated one is retried as a real one would be
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

/** The Test button: there is nothing to reach, so nothing is asked. */
export const probeSimulated = (): EndpointProbe => ({
  ok: true,
  message: "Simulated: answered here, without a request",
  ms: 0,
});

/** "Fetch from server": the voices every simulated endpoint has. */
export const simulatedVoices = (): VoiceListPage => onePage([...SIMULATED_VOICES]);
