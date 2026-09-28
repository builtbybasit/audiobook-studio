// A voice made from someone's recordings, kept by the provider as one more voice on the account.
//
// Only providers that keep a cloned voice and answer with an id for it are cloned through here — a
// voice made this way is then an ordinary voice: listed by "Fetch", cast like any other, and sent
// by id with every line, so the recordings go out once rather than with every request.
//
// Fish Audio is the one so far (https://docs.fish.audio/api-reference/endpoint/model/create-model):
// `POST /model` on the API's host, as multipart, with `type=tts`, a title, `train_mode=fast` — the
// model is usable at once — and 1 to 20 recordings under `voices`. With no `texts` Fish transcribes
// the recordings itself. The voice is made private: only the account that made it can use it. The
// answer is the new model, whose `_id` is the `reference_id` a line is spoken with.
//
// **Sent once.** Unlike a line of speech, making a model is not idempotent: an upload that timed
// out or met a 5xx may still have made the voice on Fish's side, and a second attempt would make a
// second one — a duplicate private voice on the account, and the upload paid for twice in time. So
// the one request goes out with no retries, whatever the endpoint's own `maxRetries`, and a failure
// is said at once; the person can look at their Fish voices and try again knowingly.
//
// **What counts as a recording** is read from the file's first bytes, the way a cover's type is
// (`covers/files.ts`), rather than from its name or the type the browser guessed. Only the formats
// Fish documents for a voice sample are sent: WAV, MP3, M4A and Opus for a model
// (https://docs.fish.audio/features/voice-cloning), and FLAC besides for a reference in a speech
// request (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) — anything
// else would be an upload Fish may refuse after the wait.
import type { Voice } from "@/types";
import { canCloneVoices, fishApiRoot } from "@/lib/endpointShapes";
import { authHeaders, call, ProviderError, requireKey, type CallOptions } from "~/providers/http";
import type { ProviderTarget } from "~/providers/target";

/** One recording to make the voice from. */
export interface CloneClip {
  name: string;
  /**
   * The recording as the form parser holds it, typed by what its bytes say it is — handed to the
   * provider's form as it stands, so the upload is kept in memory once rather than copied again.
   */
  blob: Blob;
}

export interface CloneRequest {
  /** what the voice is called, on the provider and on the endpoint */
  title: string;
  clips: CloneClip[];
}

/** The port the route clones through; a test hands over one that answers from memory. */
export interface VoiceCloner {
  clone(target: ProviderTarget, request: CloneRequest, signal: AbortSignal): Promise<Voice>;
}

// ---------- what a recording is ----------

export type RecordingFormat = "wav" | "mp3" | "m4a" | "opus" | "flac";

/** The media type each format is sent to the provider as, whatever the browser called it. */
export const RECORDING_MIME: Record<RecordingFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  opus: "audio/ogg",
  flac: "audio/flac",
};

/**
 * How much of a file's start `sniffRecording` needs: an Ogg page header of 27 bytes and up to 255
 * segment sizes before the first packet's `OpusHead`, with room to spare.
 */
export const RECORDING_HEAD_BYTES = 512;

/**
 * The brands an MP4 file names in its `ftyp` that are audio a phone or an encoder writes: an
 * iPhone's voice memo is `M4A `, an Android recorder's `isom`, `mp42` or `3gp4`. A `.mov`, a HEIC
 * photo or an AVIF image is an `ftyp` file too, and none of those is a recording.
 */
const M4A_BRANDS = /^(M4A |M4B |mp4[12]|iso[m2-6]|dash|3gp[4-6]|3g2a)$/;

const says = (b: Uint8Array, at: number, text: string): boolean =>
  b.length >= at + text.length && [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/** What a file's first bytes say it is, or null when they say none of the formats Fish takes. */
export function sniffRecording(b: Uint8Array): RecordingFormat | null {
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
 * speech; this request carries up to 100 MB of recordings and then waits while Fish transcribes
 * them. Ten minutes is the whole 100 MB at about 1.5 Mbit/s — a slow home uplink — with time left
 * for the transcription, and since there is no second attempt, one that gives up too early is a
 * failure the person has to start again by hand.
 */
export const CLONE_TIMEOUT_SEC = 600;

export interface VoiceClonerOptions extends Omit<CallOptions, "signal"> {
  /** the attempt's wall clock, in seconds; `CLONE_TIMEOUT_SEC` unless a test makes it short */
  timeoutSec?: number;
}

export function endpointVoiceCloner(options: VoiceClonerOptions = {}): VoiceCloner {
  const { timeoutSec = CLONE_TIMEOUT_SEC, ...callOptions } = options;
  return {
    async clone(target, request, signal) {
      if (!canCloneVoices(target))
        throw new ProviderError(
          `${target.name} cannot make a voice from recordings; only Fish Audio can, so far`,
          0,
          false,
        );
      requireKey(target);
      const form = new FormData();
      form.set("type", "tts");
      form.set("title", request.title);
      form.set("train_mode", "fast");
      form.set("visibility", "private");
      for (const clip of request.clips) form.append("voices", clip.blob, clip.name);
      const res = await call(
        // once, and with a clock sized for the upload: see the top of this file
        { ...target, maxRetries: 0, timeoutSec },
        `${fishApiRoot(target.baseUrl)}/model`,
        // no content-type: the multipart boundary is the form's to write
        { method: "POST", headers: authHeaders(target), body: form },
        { signal, ...callOptions },
      );
      const body = (await res.json().catch(() => null)) as {
        _id?: unknown;
        title?: unknown;
      } | null;
      if (typeof body?._id !== "string" || !body._id)
        throw new ProviderError(
          `${target.name} answered ${res.status} without the new voice's id`,
          res.status,
          false,
        );
      const title =
        typeof body.title === "string" && body.title.trim() ? body.title.trim() : request.title;
      return { id: body._id, label: title, gender: "?" };
    },
  };
}
