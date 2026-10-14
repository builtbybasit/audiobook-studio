// WAV reading and writing for the whole server. A streamed WAV (Fish, OpenAI) has placeholder sizes
// (`ffffff24`), so an endpoint's answer is rewritten under a plain 44-byte header with only the
// whole frames that arrived, and its duration counted from them (`plainWav`).

const HEADER = 44;

export interface WavFormat {
  channels: number;
  sampleRate: number;
  bits: number;
}

/** `start` and `length` of the samples, in bytes. */
export interface WavBody extends WavFormat {
  start: number;
  length: number;
}

export const formatLabel = (f: WavFormat): string =>
  `${f.sampleRate} Hz, ${f.bits}-bit, ${f.channels === 1 ? "mono" : `${f.channels} channels`}`;

export const byteRate = (f: WavFormat): number => (f.sampleRate * f.channels * f.bits) / 8;

/**
 * Whole frames only: a byte count that splits a frame shifts every later sample a byte out of step,
 * which plays as loud noise to the end of the file.
 */
export const silenceBytes = (f: WavFormat, seconds: number): number =>
  Math.round(seconds * f.sampleRate) * ((f.channels * f.bits) / 8);

/** 8-bit PCM is unsigned (zero is 128); wider is signed. Wrong is a click between every clip. */
export const silentByte = (f: WavFormat): number => (f.bits === 8 ? 128 : 0);

/** Walks the chunks rather than assume 44 bytes: a `LIST` chunk may come before `data`. */
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
      // a size of 0 means still being written: take everything after the header
      return { ...format, start: body, length: size || head.byteLength - body };
    }
    at = body + size + (size % 2);
  }
  throw new Error("it has no samples in it");
}

/** Joins WAVs end to end, a number in `pieces` being seconds of silence. Formats must match. */
export function joinWav(pieces: (Uint8Array | number)[]): Uint8Array {
  const files = pieces.filter((p) => typeof p !== "number");
  const bodies = files.map((f) => readWavHeader(f));
  const first = bodies[0];
  if (!first) throw new Error("there was nothing to join");
  for (const [i, b] of bodies.entries())
    if (b.channels !== first.channels || b.sampleRate !== first.sampleRate || b.bits !== first.bits)
      throw new Error(
        `part ${i + 1} came back as ${formatLabel(b)} and part 1 as ${formatLabel(first)}`,
      );
  let file = 0;
  const spans = pieces.map((p) => {
    if (typeof p === "number")
      return new Uint8Array(silenceBytes(first, p)).fill(silentByte(first));
    const b = bodies[file++];
    // a header may claim more samples than the file holds
    return p.subarray(b.start, b.start + b.length);
  });
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
  /** RIFF, `fmt `, `data` and nothing else, every size true */
  bytes: Uint8Array;
  format: WavFormat;
  /** seconds */
  duration: number;
}

/** The samples under a truthful header; throws when there is no WAV or no sample. */
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
  // a streaming header's size is a placeholder
  const arrived = Math.min(body.length, bytes.byteLength - body.start);
  const length = arrived - (arrived % frame);
  if (length <= 0) throw new Error("it has no samples in it");
  return {
    bytes: joinWav([bytes.subarray(0, body.start + length)]),
    format,
    duration: length / byteRate(format),
  };
}
