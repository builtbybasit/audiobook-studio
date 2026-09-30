// What voices a speech endpoint offers, asked of the endpoint itself.
//
// Each provider lists its voices its own way, and its wire module (`speech/`) says how: Fish's
// library a hundred models a page, ElevenLabs' at `GET /v2/voices` and BreezeBlue's at
// `GET /v1/voices` a page at a time, MiniMax's at `POST /v1/get_voice` all at once, Cartesia's a
// page after the last voice of the one before. Gemini's prebuilt voices, OpenAI's built-in ones and
// each Qwen model's system voices are written down in their docs, so they are answered without a
// request; any other OpenAI-shaped server is asked `GET /audio/voices`. Fish also has a public
// catalogue, searched a page at a time, and is the only provider that has one. A simulated endpoint
// is asked nothing: its voices are the few it names (`simulatedSpeech.ts`), and it has no key to
// need.
//
// Listing spends nothing and changes nothing, which is why the route always calls the real lister:
// only a test hands over one that answers from memory.
import type { VoiceListPage } from "@/types";
import { isSimulated } from "@/lib/providers";
import { sniffSample, type SampleFormat } from "~/providers/clone";
import { ProviderError, requireKey, type CallOptions } from "~/providers/http";
import { simulatedVoices } from "~/providers/simulatedSpeech";
import { wireOf } from "~/providers/speech/registry";
import type { ProviderTarget } from "~/providers/target";

export { PUBLIC_PAGE } from "~/providers/speech/fish";
export { OPENAI_VOICES } from "~/providers/speech/openai";

/** Which catalogue to read, and for the public one what to look for. */
export interface VoiceQuery {
  /** `library`: the account's own voices, all of them; `public`: one page of a search */
  source: "library" | "public";
  /** words in the title; a 32-character Fish id finds that one voice */
  query?: string;
  /** a language code the voices must speak, e.g. `en` */
  language?: string;
  /** 1-based */
  page?: number;
}

/** A provider's own recording of a voice, fetched: the file as it was served, and what it says. */
export interface VoiceRecording {
  bytes: Uint8Array;
  format: SampleFormat;
  text: string;
}

/** The largest recording fetched; Fish's run to a few hundred kilobytes. */
const RECORDING_BYTES = 10 * 1024 * 1024;
/** How long fetching one may take, on top of whatever the request's own signal allows. */
const RECORDING_MS = 30_000;

/** The port the route lists through; a test hands over one that answers from memory. */
export interface VoiceLister {
  list(target: ProviderTarget, query: VoiceQuery, signal: AbortSignal): Promise<VoiceListPage>;
  /**
   * The provider's own recording of one voice, fetched, when it keeps one (`SpeechWire.recording`)
   * — null otherwise, and for a simulated endpoint. Nothing here is billed.
   */
  recording?(
    target: ProviderTarget,
    voice: string,
    signal: AbortSignal,
  ): Promise<VoiceRecording | null>;
}

/** A search of a provider that has no public catalogue — every one but Fish. */
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
      // The link is on the provider's own host (`fishSampleOf`), and holds no key: fetched as it is.
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
      // a file that is not audio this server can name is no recording to play
      return format ? { bytes, format, text: found.text } : null;
    },
  };
}
