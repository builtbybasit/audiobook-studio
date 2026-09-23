// An encoder that stitches the rendered clips into one playable file, and never the network.
//
// It is the counterpart of the fake speech model: that one writes a real WAV per line, this one
// joins them into a real WAV per output file, so what the Export page's build, its download and
// its "needs an update" comparison exercise is a file being written and read rather than a
// progress bar being counted down. Stitching is all it does — there is no resampling, no gain and
// no chapter marks — which is why `markers` is false and why the build says plainly in its log
// that the format the settings asked for is not the one it wrote.
//
// It does not assume the fake's format. Every source file's RIFF header is read and checked
// against the file being written, so a speech provider that answers at 24 kHz or in 16-bit
// stitches correctly, and one that changes format mid-chapter is an error naming the file rather
// than a burst of noise in the middle of an audiobook.
import { open, readFile } from "node:fs/promises";

import type {
  AudiobookEncoder,
  EncodeInput,
  EncodedChapter,
  EncodedFile,
  EncoderChoice,
  FreshPart,
} from "~/providers/encoder";

const HEADER = 44;
/** how much of a carried span is moved at a time, so a long chapter is not held in memory */
const COPY_CHUNK = 1 << 20;

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

/** The 44 bytes that say what the samples after them are. */
function wavHeader(f: WavFormat, samples: number): Uint8Array {
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

export function wavEncoder(): AudiobookEncoder {
  return {
    name: "WAV stitcher (local)",
    ext: "wav",
    mime: "audio/wav",
    // Nothing here writes a chapter mark: a RIFF file has nowhere every player would read one.
    markers: false,
    // and nothing here measures anything: the clips go in at the level they came out at
    normalizes: false,
    // raw samples, so a chapter that has not moved really is the same bytes in the same order
    carries: true,
    // and no picture: nothing reads one out of a RIFF file
    covers: false,
    // nor any words about the book: a RIFF INFO chunk exists, but few players read one
    tags: false,

    async encode({ chapters, gap, out, signal, onChapter }: EncodeInput): Promise<EncodedFile> {
      const file = await open(out, "w");
      // The header cannot be written until the format and the length are known, and neither is
      // until every part has been laid down, so the file opens with a hole where it goes.
      let at = HEADER;
      let format: WavFormat | null = null;
      const written: EncodedChapter[] = [];

      /** The first file read decides the format; every one after it has to agree. */
      const agree = (body: WavBody, path: string): WavFormat => {
        const f = { channels: body.channels, sampleRate: body.sampleRate, bits: body.bits };
        if (!format) return (format = f);
        if (
          format.channels !== f.channels ||
          format.sampleRate !== f.sampleRate ||
          format.bits !== f.bits
        )
          throw new Error(`${path} is ${formatLabel(f)} and this file is ${formatLabel(format)}`);
        return format;
      };

      const unreadable = (path: string, e: unknown): Error =>
        new Error(`${path} could not be read as audio: ${(e as Error).message}`);

      const append = async (bytes: Uint8Array): Promise<void> => {
        await file.write(bytes, 0, bytes.byteLength, at);
        at += bytes.byteLength;
      };

      const silence = async (seconds: number): Promise<void> => {
        // Silence has no format of its own, so a pause with no audio before it anywhere in the
        // file is not written. The plan never asks for one: a pause follows the line it belongs
        // to, and a gap falls between two chapters that both have audio.
        if (!format || seconds <= 0) return;
        await append(Buffer.alloc(silenceBytes(format, seconds), silentByte(format)));
      };

      /** A whole clip, header trimmed off. They are one line long, so they are read whole. */
      const clip = async (path: string): Promise<void> => {
        const bytes = new Uint8Array(await readFile(path));
        let body: WavBody;
        try {
          body = readWavHeader(bytes);
        } catch (e) {
          throw unreadable(path, e);
        }
        agree(body, path);
        await append(bytes.subarray(body.start, body.start + body.length));
      };

      /**
       * A span of a file this export supersedes, moved a chunk at a time. False if the file is
       * gone: the version it belonged to was removed while this build ran. Once it is open it
       * stays readable to the end, however soon after that it is removed.
       */
      const carry = async (path: string, start: number, length: number): Promise<boolean> => {
        let handle;
        try {
          handle = await open(path, "r");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw e;
        }
        try {
          const head = Buffer.alloc(4096);
          const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
          let body: WavBody;
          try {
            body = readWavHeader(head.subarray(0, bytesRead));
          } catch (e) {
            throw unreadable(path, e);
          }
          agree(body, path);
          // A carried span is addressed from the start of the samples and not the start of the
          // file, because the header it is copied out of is not the one it is going into.
          const from = body.start + start;
          const buffer = Buffer.alloc(Math.min(COPY_CHUNK, length));
          for (let done = 0; done < length;) {
            if (signal.aborted) throw signal.reason;
            const want = Math.min(buffer.byteLength, length - done);
            const read = await handle.read(buffer, 0, want, from + done);
            if (!read.bytesRead) throw new Error(`${path} is shorter than the span claimed`);
            await append(buffer.subarray(0, read.bytesRead));
            done += read.bytesRead;
          }
        } finally {
          await handle.close();
        }
        return true;
      };

      const fresh = async (part: FreshPart): Promise<void> => {
        if (part.kind === "silence") await silence(part.seconds);
        else await clip(part.path);
      };

      try {
        for (const [i, chapter] of chapters.entries()) {
          if (signal.aborted) throw signal.reason;
          // The gap between two chapters belongs to the export and exists only once they are
          // stitched, so it is laid down here and never counted inside a chapter's span.
          if (i > 0) await silence(gap);
          const start = at;
          let readAgain = false;
          for (const part of chapter.parts) {
            if (signal.aborted) throw signal.reason;
            if (part.kind !== "carry") await fresh(part);
            else if (!(await carry(part.path, part.start, part.length))) {
              readAgain = true;
              for (const instead of part.instead) {
                if (signal.aborted) throw signal.reason;
                await fresh(instead);
              }
            }
          }
          const landed: EncodedChapter = {
            id: chapter.id,
            start: start - HEADER,
            length: at - start,
            seconds: format ? (at - start) / byteRate(format) : 0,
            ...(readAgain ? { readAgain } : {}),
          };
          written.push(landed);
          onChapter?.(landed, i);
        }

        const samples = at - HEADER;
        if (!format) throw new Error("there was nothing to write");
        await file.write(wavHeader(format, samples), 0, HEADER, 0);
        return { bytes: at, seconds: samples / byteRate(format), chapters: written };
      } finally {
        await file.close();
      }
    },
  };
}

/**
 * The stitcher, whatever the settings ask for.
 *
 * It is the default because it needs nothing installed: a fresh clone, a CI run and the test
 * suite all build a real, playable audiobook without a binary on the machine. What it cannot do
 * — an M4B, an MP3, chapter marks, measured loudness — is what `EXPORT_ENCODER=ffmpeg` is for.
 */
export const wavEncoders = (): EncoderChoice => {
  const one = wavEncoder();
  return { name: one.name, for: () => one };
};
