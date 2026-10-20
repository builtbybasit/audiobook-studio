// What a speech provider's wire module answers for: its own API as its docs give it, and nothing
// else. Retries and the ledger are `send.ts`'s, format checks `answer.ts`'s, the choice of provider
// `registry.ts`'s; the page's description of each provider is in `lib/providers/`.
import { call, ProviderError } from "~/providers/http";
import type { EndpointBatches, EndpointProbe, MadeVoice, VoiceListPage } from "@/types";
import type { CloneRequest } from "~/providers/clone";
import type { SpeechCallOptions, SpeechRequest } from "~/providers/send";
import type { SpeechBatch, SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import type { VoiceQuery } from "~/providers/voices";

export interface SpeechWire {
  /** Throws a `ProviderError` before sending for a line the endpoint's setup cannot ask for. */
  request(input: SpeechInput, target: ProviderTarget, voice: string): SpeechRequest;
  /** The Test button: proves the host and the key, and renders nothing. */
  probe(
    target: ProviderTarget,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<EndpointProbe>;
  /** The account's own voices, every page up to a cap. */
  voices(
    target: ProviderTarget,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<VoiceListPage>;
  /**
   * Only for a provider with `cloning`. The target has `maxRetries: 0` (`clone.ts`); a multi-step
   * clone says which step failed. Samples arrive checked and typed by their bytes.
   */
  clone?(
    target: ProviderTarget,
    request: CloneRequest,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<MadeVoice>;
  /** Only for a provider whose `cloning.deletes`; a voice already gone is not a failure. */
  deleteVoice?(
    target: ProviderTarget,
    voice: string,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<void>;
  /** Asked afresh; the provider caches it. Only the compatible wire has it (`batch.ts`). */
  capabilities?(
    target: ProviderTarget,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<EndpointBatches>;
  /** `voices[i]` is item `i`'s voice id; items are already checked (`batch.ts`). */
  speakBatch?(
    batch: SpeechBatch,
    voices: string[],
    options: SpeechCallOptions & { billsFailures: boolean },
  ): Promise<void>;
  /** A free link to the provider's recording of a voice and its text (Fish only); null if none. */
  recording?(
    target: ProviderTarget,
    voice: string,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<{ url: string; text: string } | null>;
  /** One page of the public catalogue (Fish only). */
  search?(
    target: ProviderTarget,
    query: VoiceQuery,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<VoiceListPage>;
}

export const onePage = (voices: VoiceListPage["voices"]): VoiceListPage => ({
  voices,
  total: voices.length,
  page: 1,
  hasMore: false,
});

export async function getJson<T>(
  target: ProviderTarget,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<T> {
  const res = await call(target, url, { method: "GET", headers }, { signal, ...options });
  try {
    return (await res.json()) as T;
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ProviderError(
      `${target.name} answered ${url} with something that is not JSON`,
      res.status,
      false,
    );
  }
}
