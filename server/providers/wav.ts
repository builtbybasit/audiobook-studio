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
//
// And what every WAV in the server is read and written with: a header walked for its format and
// samples (`readWavHeader`), several joined into one (`joinWav`), and the 44 bytes in front.

const HEADER = 44;

export interface WavFormat {
  channels: number;
  sampleRate: number;
  bits: number;
}

/** Where the samples of a RIFF/WAVE file start, how many there are, and what they are. */
export interface WavBody extends WavFormat {
  start: number;
  length: number;
}

export const formatLabel = (f: WavFormat): string =>
  `${f.sampleRate} Hz, ${f.bits}-bit, ${f.channels === 1 ? "mono" : `${f.channels} channels`}`;

/** Bytes per second of audio, which is what turns a pause in seconds into a run of silence. */
export const byteRate = (f: WavFormat): number => (f.sampleRate * f.channels * f.bits) / 8;

/**
 * How many bytes of silence a pause is: whole sample frames, never a byte count that splits one.
 *
 * `seconds × byteRate` rounded to a byte is right only for 8-bit mono, where a frame is one byte.
 * For 16-bit audio a pause of 0.1234 s at 24 kHz is 5,923 bytes — an odd number — and every sample
 * after it is read a byte out of step, which plays as loud noise to the end of the file. So the
 * pause is rounded to a whole number of frames first, and a frame is every channel's sample.
 */
export const silenceBytes = (f: WavFormat, seconds: number): number =>
  Math.round(seconds * f.sampleRate) * ((f.channels * f.bits) / 8);

/**
 * Silence, as this format spells it: 8-bit PCM is unsigned and its zero is 128, everything wider
 * is signed and its zero is 0. Getting this wrong is a click between every clip.
 */
export const silentByte = (f: WavFormat): number => (f.bits === 8 ? 128 : 0);

/**
 * Read a RIFF/WAVE header: the format, and where the samples are.
 *
 * The chunks are walked rather than assumed to be the canonical 44 bytes, because a file with a
 * `LIST` chunk before its `data` is still a WAV and cutting it at 44 would put metadata into the
 * audiobook.
 */
export function readWavHeader(head: Uint8Array): WavBody {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number): string => String.fromCharCode(...head.subarray(at, at + 4));
  if (head.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    throw new Error("not a RIFF/WAVE file");

  let format: WavFormat | null = null;
  for (let at = 12; at + 8 <= head.byteLength;) {
    const name = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (name === "fmt " && size >= 16)
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    if (name === "data") {
      if (!format) throw new Error("its samples come before it says what they are");
      // A `data` size of zero is how a file still being written describes itself; what is really
      // there is everything after the header.
      return { ...format, start: body, length: size || head.byteLength - body };
    }
    at = body + size + (size % 2);
  }
  throw new Error("it has no samples in it");
}

/**
 * Several WAV files as one, their samples end to end with nothing between them: a line an endpoint
 * would only take in parts, put back together. They have to agree on what a sample is — 24 kHz
 * laid after 22.05 kHz plays at the wrong pitch — and a part that does not is named by its place.
 */
export function joinWav(files: Uint8Array[]): Uint8Array {
  const bodies = files.map((f) => readWavHeader(f));
  const first = bodies[0];
  if (!first) throw new Error("there was nothing to join");
  for (const [i, b] of bodies.entries())
    if (b.channels !== first.channels || b.sampleRate !== first.sampleRate || b.bits !== first.bits)
      throw new Error(
        `part ${i + 1} came back as ${formatLabel(b)} and part 1 as ${formatLabel(first)}`,
      );
  // what is really there, if a header claims more samples than the file holds
  const spans = bodies.map((b, i) => files[i].subarray(b.start, b.start + b.length));
  const length = spans.reduce((a, s) => a + s.byteLength, 0);
  const out = new Uint8Array(HEADER + length);
  out.set(wavHeader(first, length));
  let at = HEADER;
  for (const s of spans) {
    out.set(s, at);
    at += s.byteLength;
  }
  return out;
}

/** The 44 bytes that say what the samples after them are. */
export function wavHeader(f: WavFormat, samples: number): Uint8Array {
  const bytes = new Uint8Array(HEADER);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, f.channels, true);
  view.setUint32(24, f.sampleRate, true);
  view.setUint32(28, byteRate(f), true);
  view.setUint16(32, (f.channels * f.bits) / 8, true);
  view.setUint16(34, f.bits, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  return bytes;
}

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
