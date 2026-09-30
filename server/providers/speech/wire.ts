// What a speech provider's wire module answers for: its request, its Test button, its voices.
//
// One module per provider under this folder, each the provider's own API as its docs give it, and
// nothing else — the retries and the ledger are `send.ts`'s, the format checks `answer.ts`'s, the
// choice of provider the registry's (`registry.ts`). What the page also needs to know about a
// provider without a request is its description in `lib/providers/`.
import { call, ProviderError } from "~/providers/http";
import type { EndpointProbe, MadeVoice, VoiceListPage } from "@/types";
import type { CloneRequest } from "~/providers/clone";
import type { SpeechCallOptions, SpeechRequest } from "~/providers/send";
import type { BatchLimits, SpeechBatch, SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import type { VoiceQuery } from "~/providers/voices";

export interface SpeechWire {
  /**
   * The request one line goes out as. Throws a `ProviderError`, before anything is sent, for a
   * line this provider cannot be asked for as the endpoint is set up — the format has already been
   * held to the provider's formats by then.
   */
  request(input: SpeechInput, target: ProviderTarget, voice: string): SpeechRequest;
  /** The Test button: one request that proves the host and the key, and renders nothing. */
  probe(
    target: ProviderTarget,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<EndpointProbe>;
  /** The account's own voices, every page up to a cap — the Voices tab's "Fetch from server". */
  voices(
    target: ProviderTarget,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<VoiceListPage>;
  /**
   * A voice made from someone's samples and kept on the account, answered as a voice a line can
   * then be spoken with by id — for a provider whose description has `cloning`, and only those.
   *
   * The target comes with `maxRetries: 0` and the clone's own clock (`clone.ts`): making a voice is
   * not idempotent, so every request here goes out once, whatever the endpoint's retries. A clone
   * that takes several requests (an upload, then the clone) makes each once, and a failure part way
   * says which step failed. The samples arrive already held to the provider's `cloning` limits and
   * typed by their bytes (`sample.format`, and the blob's type is that format's media type).
   */
  clone?(
    target: ProviderTarget,
    request: CloneRequest,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<MadeVoice>;
  /**
   * Whether the endpoint's model takes lines in batches, asked of the server afresh — the provider
   * remembers the answer. Only a server that speaks the batch speech API has it, and so only the
   * compatible shape's wire (`batch.ts`): no hosted provider has the route. Present exactly when
   * `speakBatch` is.
   */
  batchLimits?(
    target: ProviderTarget,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<BatchLimits | null>;
  /**
   * A batch sent in one request, each item told and reported as it is answered (`batch.ts`).
   * `voices[i]` is item `i`'s voice id; every item has been through the checks a line gets before
   * any request, and `billsFailures` is the provider's.
   */
  speakBatch?(
    batch: SpeechBatch,
    voices: string[],
    options: SpeechCallOptions & { billsFailures: boolean },
  ): Promise<void>;
  /**
   * The provider's own recording of one voice, where it keeps one — a link to the file and what
   * is said in it. Asking costs nothing, and neither does the file. Null for a voice that has none,
   * or that the provider does not know. Only Fish keeps one with a voice.
   */
  recording?(
    target: ProviderTarget,
    voice: string,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<{ url: string; text: string } | null>;
  /** One page of the provider's public catalogue, for the one provider that has one (Fish). */
  search?(
    target: ProviderTarget,
    query: VoiceQuery,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<VoiceListPage>;
}

/** A list answered in one go, as a page: every voice, nothing more to fetch. */
export const onePage = (voices: VoiceListPage["voices"]): VoiceListPage => ({
  voices,
  total: voices.length,
  page: 1,
  hasMore: false,
});

/**
 * A GET whose answer is JSON — a voice list, a model list — with the endpoint's retries. An answer
 * that is not JSON is a failure that says which address answered it.
 */
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
