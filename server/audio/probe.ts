// What a clip is, read off its bytes: how long it plays and at what rate, in whichever of the
// three formats it was kept in.
//
// A clip is kept exactly as the endpoint sent it — a WAV, an MP3 or an Ogg Opus file — and its
// file name's extension says which (`AUDIO_EXT`). Everything that needs to know about one asks
// here rather than reading a RIFF header itself: the providers when an answer comes back, the
// narration job when it records the rate, the join when a line came in parts, the export when it
// decides whether a clip needs decoding first.
//
// A WAV is read by its header, which the server wrote and trusts. An MP3 or an Opus file is read
// by `music-metadata`, which knows both containers, with `duration: true` so it reads the whole
// file rather than guessing from the first few pages: an Ogg stream's length is the last page's
// granule, which it does not reach otherwise. An MP3's length is counted from its frames
// (`mp3.ts`), which is exact where `music-metadata`'s constant-bitrate estimate from the file size
// is a frame out every few minutes.
//
// A line sent in parts comes back as one file per part and is kept as one: WAV samples end to end,
// MP3 frames end to end. Opus is refused before the parts are sent (`narration.ts`): two Ogg
// streams one after the other are a legal "chained" file, but browsers seek in one badly and
// report its length as the first stream's.
import { parseBuffer } from "music-metadata";

import type { AudioFormat } from "@/types";
import { AUDIO_MIME, FORMAT_LABEL } from "@/lib/endpointShapes";
import { joinMp3, mp3Frames } from "~/audio/mp3";
import { byteRate, joinWav, readWavHeader } from "~/providers/wavEncoder";

/** What a clip's bytes say about it. */
export interface ClipInfo {
  format: AudioFormat;
  /** in Hz, as the file plays: an Opus file always decodes at 48 kHz */
  sampleRate: number;
  channels: number;
  /** how long it plays, in seconds */
  duration: number;
}

/** What `music-metadata` calls the container and codec each encoded format is in. */
const EXPECTED: Record<Exclude<AudioFormat, "wav">, { container: string; codec: RegExp }> = {
  mp3: { container: "MPEG", codec: /layer 3/i },
  opus: { container: "Ogg", codec: /^opus$/i },
};

/**
 * Read a clip: its rate, its channels and how long it plays. Throws, saying why in words a person
 * can act on, when the bytes are not the format they are said to be or hold no audio at all.
 */
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
 * The parts of a line as one clip in their format: WAV samples or MP3 frames end to end, nothing
 * between them. Throws for Opus, which is refused before its parts are sent, and for parts that
 * disagree on what they are, naming the one that does.
 */
export function joinClips(format: AudioFormat, parts: Uint8Array[]): Uint8Array {
  if (format === "wav") return joinWav(parts);
  if (format === "mp3") return joinMp3(parts);
  throw new Error(`${FORMAT_LABEL[format]} parts cannot be joined into one clip`);
}
