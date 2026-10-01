// A voice made from someone's samples, kept by the provider as one more voice on the account.
//
// Only providers that keep a cloned voice and answer with an id for it are cloned through here — a
// voice made this way is then an ordinary voice: listed by "Fetch", cast like any other, and sent
// by id with every line, so the samples go out once rather than with every request. Which providers
// can is their description's `cloning` (`lib/providers/`); how the request goes is their wire
// module's `clone` (`speech/<provider>.ts`). This file is what they share: the port the route
// clones through, what a sample is, and the rule that a clone is sent once.
//
// **Sent once.** Unlike a line of speech, making a voice is not idempotent: an upload that timed
// out or met a 5xx may still have made the voice on the provider's side, and a second attempt would
// make a second one — a duplicate private voice on the account, and the upload paid for twice in
// time. So every request of a clone goes out with no retries, whatever the endpoint's own
// `maxRetries`, and a failure is said at once; the person can look at their voices on the provider
// and try again knowingly.
//
// **What counts as a sample** is read from the file's first bytes, the way a cover's type is
// (`covers/files.ts`), rather than from its name or the type the browser guessed: a file is what
// it holds, whatever it was saved as. The sniffer knows WAV, MP3, M4A, Opus and FLAC; each
// provider's `cloning.formats` says which of those it takes. A sample may come with a transcript
// of what is said in it, which a provider whose `cloning.transcript` is not "none" is sent.
import type { MadeVoice } from "@/types";
import { speechProviderOf, type SampleFormat } from "@/lib/providers";
import { ProviderError, requireKey, type CallOptions } from "~/providers/http";
import { wireOf } from "~/providers/speech/registry";
import type { ProviderTarget } from "~/providers/target";

export type { SampleFormat } from "@/lib/providers";

/** One sample to make the voice from. */
export interface SampleUpload {
  /** the file's name as the person picked it, for display and for a provider that wants one */
  name: string;
  /** what its first bytes say it is — one of the provider's `cloning.formats` */
  format: SampleFormat;
  /**
   * The file as the form parser holds it, typed by what its bytes say it is — handed to the
   * provider's form as it stands, so the upload is kept in memory once rather than copied again.
   */
  blob: Blob;
  /** what is said in it, trimmed; absent when the person gave none */
  transcript?: string;
}

export interface CloneRequest {
  /** what the voice is called, on the provider and on the endpoint */
  title: string;
  samples: SampleUpload[];
}

/** The port the route clones through; a test hands over one that answers from memory. */
export interface VoiceCloner {
  clone(target: ProviderTarget, request: CloneRequest, signal: AbortSignal): Promise<MadeVoice>;
}

// ---------- what a sample is ----------

/** The media type each format is sent to the provider as, whatever the browser called it. */
export const SAMPLE_MIME: Record<SampleFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  opus: "audio/ogg",
  flac: "audio/flac",
};

/**
 * How much of a file's start `sniffSample` needs: an Ogg page header of 27 bytes and up to 255
 * segment sizes before the first packet's `OpusHead`, with room to spare.
 */
export const SAMPLE_HEAD_BYTES = 512;

/**
 * The brands an MP4 file names in its `ftyp` that are audio a phone or an encoder writes: an
 * iPhone's voice memo is `M4A `, an Android voice app's `isom`, `mp42` or `3gp4`. A `.mov`, a HEIC
 * photo or an AVIF image is an `ftyp` file too, and none of those is a sample.
 */
const M4A_BRANDS = /^(M4A |M4B |mp4[12]|iso[m2-6]|dash|3gp[4-6]|3g2a)$/;

const says = (b: Uint8Array, at: number, text: string): boolean =>
  b.length >= at + text.length && [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/** What a file's first bytes say it is, or null when they say none of the formats the sniffer knows. */
export function sniffSample(b: Uint8Array): SampleFormat | null {
  if (says(b, 0, "RIFF") && says(b, 8, "WAVE")) return "wav";
  if (says(b, 0, "fLaC")) return "flac";
  if (says(b, 4, "ftyp") && M4A_BRANDS.test(String.fromCharCode(...b.subarray(8, 12))))
    return "m4a";
  // An Ogg page is a 27-byte header, then one byte per segment of the page; the first packet of
  // an Opus stream is its `OpusHead`. A Vorbis `.ogg` has `\x01vorbis` there, and is refused.
  if (says(b, 0, "OggS") && b.length > 26 && says(b, 27 + b[26], "OpusHead")) return "opus";
  // An ID3 tag in front is an MP3's; so is an MPEG audio frame's header: eleven bits of sync, a
  // version other than the reserved one, and layer III. AAC's ADTS header has the same sync and
  // layer 0, which is how it is told apart.
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
 * The one attempt's wall clock, in seconds. The endpoint's own timeout is sized for a line of
 * speech; a clone carries up to 100 MB of samples and then waits while the provider works on
 * them (Fish transcribes them). Ten minutes is the whole 100 MB at about 1.5 Mbit/s — a slow home uplink — with time left
 * for the transcription, and since there is no second attempt, one that gives up too early is a
 * failure the person has to start again by hand.
 */
const CLONE_TIMEOUT_SEC = 600;

export interface VoiceClonerOptions extends Omit<CallOptions, "signal"> {
  /** the attempt's wall clock, in seconds; `CLONE_TIMEOUT_SEC` unless a test makes it short */
  timeoutSec?: number;
}

export function endpointVoiceCloner(options: VoiceClonerOptions = {}): VoiceCloner {
  const { timeoutSec = CLONE_TIMEOUT_SEC, ...callOptions } = options;
  return {
    async clone(target, request, signal) {
      const shape = speechProviderOf(target);
      // a provider described without cloning is never asked for its wire: a simulated one has none
      const clone = shape.cloning && wireOf(target).wire.clone;
      if (!clone)
        throw new ProviderError(
          `${target.name} cannot make a voice from samples: ${shape.label} has no cloning this app speaks to`,
          0,
          false,
        );
      requireKey(target);
      // once, and with a clock sized for the upload: see the top of this file
      return clone({ ...target, maxRetries: 0, timeoutSec }, request, signal, callOptions);
    },
  };
}
