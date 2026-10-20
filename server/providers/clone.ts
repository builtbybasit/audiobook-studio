// Voice cloning for providers that keep the clone and answer with an id, so samples go out once.
// Which providers can is `cloning` in `lib/providers/`; the request is each wire's `clone`.
// A clone is sent once, never retried: a timed-out upload may still have made the voice, and a
// retry would make a duplicate. A sample's format is sniffed from its bytes, not its name.
import type { MadeVoice } from "@/types";
import { speechProviderOf, type SampleFormat } from "@/lib/providers";
import { ProviderError, requireKey, type CallOptions } from "~/providers/http";
import { wireOf } from "~/providers/speech/registry";
import type { ProviderTarget } from "~/providers/target";

export type { SampleFormat } from "@/lib/providers";

/** One sample to make the voice from. */
export interface SampleUpload {
  name: string;
  /** sniffed; one of the provider's `cloning.formats` */
  format: SampleFormat;
  /** the form parser's own, passed on as is so the upload is not copied again */
  blob: Blob;
  /** trimmed; absent when the person gave none */
  transcript?: string;
}

export interface CloneRequest {
  title: string;
  samples: SampleUpload[];
}

/** The port the route clones through. */
export interface VoiceCloner {
  /** `wentOut` is told when the first request leaves: a cancel after it may have made the voice. */
  clone(
    target: ProviderTarget,
    request: CloneRequest,
    signal: AbortSignal,
    wentOut?: () => void,
  ): Promise<MadeVoice>;
  /** Delete a made voice on the provider; one already gone is not a failure. */
  remove?(target: ProviderTarget, voice: string, signal: AbortSignal): Promise<void>;
}

// ---------- what a sample is ----------

/** Sent as this, whatever the browser called it. */
export const SAMPLE_MIME: Record<SampleFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  opus: "audio/ogg",
  flac: "audio/flac",
};

/** Room for an Ogg page header (27 bytes) and 255 segment sizes before `OpusHead`. */
export const SAMPLE_HEAD_BYTES = 512;

/** Audio `ftyp` brands (iPhone `M4A `, Android `isom`/`mp42`/`3gp4`); not .mov, HEIC or AVIF. */
const M4A_BRANDS = /^(M4A |M4B |mp4[12]|iso[m2-6]|dash|3gp[4-6]|3g2a)$/;

const says = (b: Uint8Array, at: number, text: string): boolean =>
  b.length >= at + text.length && text.split("").every((ch, i) => b[at + i] === ch.charCodeAt(0));

export function sniffSample(b: Uint8Array): SampleFormat | null {
  if (says(b, 0, "RIFF") && says(b, 8, "WAVE")) return "wav";
  if (says(b, 0, "fLaC")) return "flac";
  if (says(b, 4, "ftyp") && M4A_BRANDS.test(String.fromCharCode(...b.subarray(8, 12))))
    return "m4a";
  // An Ogg page: a 27-byte header, one byte per segment, then the first packet. Vorbis is refused.
  if (says(b, 0, "OggS") && b.length > 26 && says(b, 27 + b[26], "OpusHead")) return "opus";
  // ID3, or an MPEG frame header: 11 sync bits, a non-reserved version, layer III. AAC's ADTS
  // has the same sync with layer 0.
  if (says(b, 0, "ID3")) return "mp3";
  if (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    const version = (b[1] >> 3) & 3;
    const layer = (b[1] >> 1) & 3;
    if (version !== 1 && layer === 1) return "mp3";
  }
  return null;
}

// ---------- the cloner ----------

/**
 * Seconds. The endpoint's timeout is sized for a line; a clone uploads up to 100 MB (10 min at a
 * slow 1.5 Mbit/s uplink) and waits while the provider works (Fish transcribes).
 */
const CLONE_TIMEOUT_SEC = 600;

export interface VoiceClonerOptions extends Omit<CallOptions, "signal"> {
  /** seconds; `CLONE_TIMEOUT_SEC` unless a test makes it short */
  timeoutSec?: number;
}

export function endpointVoiceCloner(options: VoiceClonerOptions = {}): VoiceCloner {
  const { timeoutSec = CLONE_TIMEOUT_SEC, ...callOptions } = options;
  return {
    async clone(target, request, signal, wentOut) {
      const shape = speechProviderOf(target);
      // a simulated provider has no wire
      const wire = shape.cloning ? wireOf(target).wire : null;
      if (!wire?.clone)
        throw new ProviderError(
          `${target.name} cannot make a voice from samples: ${shape.label} has no cloning this app speaks to`,
          0,
          false,
        );
      requireKey(target);
      // once (see the header); `wentOut` fires as a request leaves through `fetch`
      const send = callOptions.fetch ?? fetch;
      return wire.clone({ ...target, maxRetries: 0, timeoutSec }, request, signal, {
        ...callOptions,
        fetch: ((url: string, init: RequestInit) => {
          wentOut?.();
          return send(url, init);
        }) as typeof fetch,
      });
    },

    async remove(target, voice, signal) {
      const wire = speechProviderOf(target).cloning?.deletes ? wireOf(target).wire : null;
      if (!wire?.deleteVoice)
        throw new ProviderError(`${target.name} cannot delete a voice on its server`, 0, false);
      requireKey(target);
      await wire.deleteVoice(target, voice, signal, callOptions);
    },
  };
}
