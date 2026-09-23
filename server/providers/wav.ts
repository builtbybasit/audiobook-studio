// What a real speech endpoint's WAV is turned into before the job keeps it.
//
// A model streams its audio, so it writes the header before it knows how long the audio will be.
// Fish Audio's answer starts `RIFF ffffff24 WAVE … data ffffff00`: sizes that claim four gigabytes
// and are true of nothing. OpenAI's `wav` is written the same way. The job reads a clip's rate
// off that header, the join and the export read its sample span, and a player seeks by it, so a
// file kept as it came would be a header everything downstream has to second-guess. Instead the
// samples that really arrived — whole frames of them, a torn last one dropped — are written out
// again under the plain 44-byte header the rest of the server already writes, and the clip's
// duration is counted from those samples rather than taken from anything the endpoint claims.
import { byteRate, joinWav, readWavHeader, type WavFormat } from "~/providers/wavEncoder";

export interface PlainWav {
  /** RIFF, `fmt `, `data` and nothing else, every size in it true */
  bytes: Uint8Array;
  format: WavFormat;
  /** how long the samples play, in seconds */
  duration: number;
}

/**
 * The samples in `bytes` under a header that tells the truth about them. Throws, saying why, when
 * there is no WAV here or no sample in it — an answer that is not audio is not a clip.
 */
export function plainWav(bytes: Uint8Array): PlainWav {
  const body = readWavHeader(bytes);
  const format: WavFormat = {
    channels: body.channels,
    sampleRate: body.sampleRate,
    bits: body.bits,
  };
  const frame = (format.channels * format.bits) / 8;
  if (!Number.isInteger(frame) || frame <= 0 || !format.sampleRate)
    throw new Error(`it says its samples are ${format.bits}-bit in ${format.channels} channels`);
  // a streaming header's size is a placeholder: what is there is what arrived
  const arrived = Math.min(body.length, bytes.byteLength - body.start);
  const length = arrived - (arrived % frame);
  if (length <= 0) throw new Error("it has no samples in it");
  // one file joined with nothing is that file under a plain header, its span cut to `length`
  return {
    bytes: joinWav([bytes.subarray(0, body.start + length)]),
    format,
    duration: length / byteRate(format),
  };
}
