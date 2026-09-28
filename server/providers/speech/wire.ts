// What a speech provider's wire module answers for: its request, its Test button, its voices.
//
// One module per provider under this folder, each the provider's own API as its docs give it, and
// nothing else — the retries and the ledger are `send.ts`'s, the format checks `answer.ts`'s, the
// choice of provider the registry's (`registry.ts`). What the page also needs to know about a
// provider without a request is its description in `lib/providers/`.
import { call, ProviderError } from "~/providers/http";
import type { SpeechCallOptions, SpeechRequest } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";
import type { VoicePage, VoiceQuery } from "~/providers/voices";

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
  ): Promise<ProbeResult>;
  /** The account's own voices, every page up to a cap — the Voices tab's "Fetch from server". */
  voices(
    target: ProviderTarget,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<VoicePage>;
  /** One page of the provider's public catalogue, for the one provider that has one (Fish). */
  search?(
    target: ProviderTarget,
    query: VoiceQuery,
    signal: AbortSignal,
    options: SpeechCallOptions,
  ): Promise<VoicePage>;
}

/** A list answered in one go, as a page: every voice, nothing more to fetch. */
export const onePage = (voices: VoicePage["voices"]): VoicePage => ({
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
