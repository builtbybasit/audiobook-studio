// A clip's rate, channels and length, read off its bytes (WAV, MP3 or Ogg Opus, as sent).
// WAV by its header; MP3 and Opus by `music-metadata` with `duration: true` (an Ogg length is the
// last page's granule); MP3 length counted from frames (`mp3.ts`). Opus parts are never joined:
// browsers seek badly in chained Ogg and report the first stream's length.
import { parseBuffer } from "music-metadata";

import type { AudioFormat } from "@/types";
import { AUDIO_MIME, FORMAT_LABEL } from "@/lib/endpointShapes";
import { joinMp3, mp3Frames } from "~/audio/mp3";
import { byteRate, joinWav, readWavHeader } from "~/providers/wav";

export interface ClipInfo {
  format: AudioFormat;
  /** in Hz, as the file plays: an Opus file always decodes at 48 kHz */
  sampleRate: number;
  channels: number;
  /** seconds */
  duration: number;
}

/** What `music-metadata` calls each format's container and codec. */
const EXPECTED: Record<Exclude<AudioFormat, "wav">, { container: string; codec: RegExp }> = {
  mp3: { container: "MPEG", codec: /layer 3/i },
  opus: { container: "Ogg", codec: /^opus$/i },
};

/** Throws, in words a person can act on, when the bytes are not that format or hold no audio. */
export async function probeClip(bytes: Uint8Array, format: AudioFormat): Promise<ClipInfo> {
  if (format === "wav") {
    const body = readWavHeader(bytes);
    const rate = byteRate(body);
    if (!rate) throw new Error("its header says it holds no samples");
    const length = Math.min(body.length, bytes.byteLength - body.start);
    return {
      format,
      sampleRate: body.sampleRate,
      channels: body.channels,
      duration: length / rate,
    };
  }
  let found;
  try {
    found = (
      await parseBuffer(
        bytes,
        { mimeType: AUDIO_MIME[format], size: bytes.byteLength },
        {
          duration: true,
          skipCovers: true,
        },
      )
    ).format;
  } catch (e) {
    throw new Error(`it cannot be read as ${FORMAT_LABEL[format]}: ${(e as Error).message}`, {
      cause: e,
    });
  }
  const want = EXPECTED[format];
  if (found.container !== want.container || !want.codec.test(found.codec ?? ""))
    throw new Error(
      `it is ${[found.container, found.codec].filter(Boolean).join(" ") || "not audio"}, not ${FORMAT_LABEL[format]}`,
    );
  if (!found.sampleRate) throw new Error("it does not say what rate it plays at");
  let duration = found.duration ?? 0;
  if (format === "mp3") {
    const frames = mp3Frames(bytes);
    duration = frames.samples / frames.sampleRate;
  }
  if (!(duration > 0)) throw new Error("it has no audio in it");
  return {
    format,
    sampleRate: found.sampleRate,
    channels: found.numberOfChannels ?? 1,
    duration,
  };
}

/**
 * A line's parts as one clip, with silence for each number of seconds among `parts` (a pause the
 * voice had no tag for). Throws for Opus and for parts that disagree.
 */
export function joinClips(format: AudioFormat, parts: (Uint8Array | number)[]): Uint8Array {
  if (format === "wav") return joinWav(parts);
  if (format === "mp3") return joinMp3(parts);
  throw new Error(`${FORMAT_LABEL[format]} parts cannot be joined into one clip`);
}
