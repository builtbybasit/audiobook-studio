// The voices a speech endpoint offers, asked of the endpoint itself through its wire module
// (`speech/`). Some providers' built-in voices come from their docs, without a request; only Fish
// has a public catalogue. Listing spends nothing, so the route always calls the real lister.
import type { VoiceListPage } from "@/types";
import { isSimulated } from "@/lib/providers";
import { sniffSample, type SampleFormat } from "~/providers/clone";
import { ProviderError, requireKey, type CallOptions } from "~/providers/http";
import { simulatedVoices } from "~/providers/simulatedSpeech";
import { wireOf } from "~/providers/speech/registry";
import type { ProviderTarget } from "~/providers/target";

export { PUBLIC_PAGE } from "~/providers/speech/fish";
export { OPENAI_VOICES } from "~/providers/speech/openai";

export interface VoiceQuery {
  /** `library`: all the account's own voices; `public`: one page of a search */
  source: "library" | "public";
  /** words in the title; a 32-character Fish id finds that one voice */
  query?: string;
  /** e.g. `en` */
  language?: string;
  /** 1-based */
  page?: number;
}

/** A provider's own recording of a voice, and what it says. */
export interface VoiceRecording {
  bytes: Uint8Array;
  format: SampleFormat;
  text: string;
}

/** Fish's run to a few hundred kilobytes. */
const RECORDING_BYTES = 10 * 1024 * 1024;
const RECORDING_MS = 30_000;

/** The port the route lists through. */
export interface VoiceLister {
  list(target: ProviderTarget, query: VoiceQuery, signal: AbortSignal): Promise<VoiceListPage>;
  /** null when the provider keeps none (`SpeechWire.recording`). Not billed. */
  recording?(
    target: ProviderTarget,
    voice: string,
    signal: AbortSignal,
  ): Promise<VoiceRecording | null>;
}

const noCatalogue = (target: ProviderTarget): ProviderError =>
  new ProviderError(
    `${target.name} has no public voice catalogue to search; only Fish Audio has one.`,
    0,
    false,
  );

export function endpointVoiceLister(
  options: Pick<CallOptions, "fetch" | "backoffMs"> = {},
): VoiceLister {
  return {
    async list(target, query, signal) {
      if (isSimulated(target.baseUrl)) {
        if (query.source === "library") return simulatedVoices();
        throw noCatalogue(target);
      }
      requireKey(target);
      const { wire } = wireOf(target);
      if (query.source === "library") return wire.voices(target, signal, options);
      if (!wire.search) throw noCatalogue(target);
      return wire.search(target, query, signal, options);
    },

    async recording(target, voice, signal) {
      if (isSimulated(target.baseUrl)) return null;
      const { wire } = wireOf(target);
      if (!wire.recording) return null;
      requireKey(target);
      const found = await wire.recording(target, voice, signal, options);
      if (!found) return null;
      // the link is on the provider's own host (`fishSampleOf`) and needs no key
      const res = await (options.fetch ?? fetch)(found.url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(RECORDING_MS)]),
      });
      if (!res.ok)
        throw new ProviderError(
          `${target.name}'s recording of this voice could not be fetched (HTTP ${res.status})`,
          res.status,
          false,
        );
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > RECORDING_BYTES)
        throw new ProviderError(`${target.name}'s recording of this voice is too large`, 0, false);
      const format = sniffSample(bytes);
      return format ? { bytes, format, text: found.text } : null;
    },
  };
}
