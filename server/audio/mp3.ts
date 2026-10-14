// MP3 as frames, so parts of a line join without decoding. The join keeps audio frames only: an
// ID3 tag would land mid-file, and a Xing/Info/VBRI frame would give the first part's length.
// Duration is counted from frames (`music-metadata` estimates CBR from file size and drifts).
// Layer III only; a torn last frame is dropped.

export interface Mp3Frames {
  sampleRate: number;
  channels: number;
  /** each audio frame's byte span; the Xing, Info or VBRI frame and any tag are not among them */
  frames: { start: number; end: number }[];
  /** audio samples per channel */
  samples: number;
}

interface FrameHeader {
  length: number;
  sampleRate: number;
  channels: number;
  samples: number;
  /** where a Xing or Info tag would start in this frame, after the side information */
  infoAt: number;
}

// Layer III bitrates in kbps, by the header's index: MPEG-1, then MPEG-2 and 2.5
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES_V1 = [44100, 48000, 32000];

function header(b: Uint8Array, at: number): FrameHeader | null {
  if (at + 4 > b.byteLength || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3; // 0 = MPEG-2.5, 1 = reserved, 2 = MPEG-2, 3 = MPEG-1
  const layer = (b[at + 1] >> 1) & 3; // 1 = Layer III
  const kbpsIndex = b[at + 2] >> 4;
  const rateIndex = (b[at + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || kbpsIndex === 0 || kbpsIndex === 15 || rateIndex === 3)
    return null;
  const v1 = version === 3;
  const kbps = (v1 ? KBPS_V1 : KBPS_V2)[kbpsIndex];
  const sampleRate = RATES_V1[rateIndex] / (v1 ? 1 : version === 2 ? 2 : 4);
  const padding = (b[at + 2] >> 1) & 1;
  const mono = b[at + 3] >> 6 === 3;
  const crc = (b[at + 1] & 1) === 0 ? 2 : 0;
  const side = v1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return {
    length: Math.floor(((v1 ? 144000 : 72000) * kbps) / sampleRate) + padding,
    sampleRate,
    channels: mono ? 1 : 2,
    samples: v1 ? 1152 : 576,
    infoAt: at + 4 + crc + side,
  };
}

const ascii = (b: Uint8Array, at: number, n: number): string =>
  String.fromCharCode(...b.subarray(at, at + n));

/** An encoder's Xing, Info or VBRI frame rather than audio. */
function isInfoFrame(b: Uint8Array, at: number, h: FrameHeader): boolean {
  const tag = ascii(b, h.infoAt, 4);
  return tag === "Xing" || tag === "Info" || ascii(b, at + 36, 4) === "VBRI";
}

/** ID3v2: ten bytes, a syncsafe size, and ten more when it has a footer. */
function skipId3v2(b: Uint8Array, at: number): number {
  while (at + 10 <= b.byteLength && ascii(b, at, 3) === "ID3") {
    const size =
      ((b[at + 6] & 0x7f) << 21) |
      ((b[at + 7] & 0x7f) << 14) |
      ((b[at + 8] & 0x7f) << 7) |
      (b[at + 9] & 0x7f);
    at += 10 + size + (b[at + 5] & 0x10 ? 10 : 0);
  }
  return at;
}

/** The next header followed by another header or EOF, so a stray 0xFF is not taken; -1 for none. */
function resync(b: Uint8Array, at: number): number {
  for (let i = at; i + 4 <= b.byteLength; i++) {
    const h = header(b, i);
    if (h && (i + h.length === b.byteLength || header(b, i + h.length))) return i;
  }
  return -1;
}

/** Throws when there are no frames, or when rate or channels change part-way. */
export function mp3Frames(b: Uint8Array): Mp3Frames {
  let at = skipId3v2(b, 0);
  const frames: Mp3Frames["frames"] = [];
  let first: FrameHeader | null = null;
  let samples = 0;
  while (at + 4 <= b.byteLength) {
    let h = header(b, at);
    if (!h) {
      // an ID3v1 or APE tag at the end, or junk between frames: look for the next real frame
      const next = resync(b, at);
      if (next < 0) break;
      at = next;
      h = header(b, at)!;
    }
    if (at + h.length > b.byteLength) break; // a torn last frame
    if (!first) {
      first = h;
      if (isInfoFrame(b, at, h)) {
        at += h.length;
        continue;
      }
    } else if (h.sampleRate !== first.sampleRate || h.channels !== first.channels)
      throw new Error(
        `its frames change from ${first.sampleRate} Hz to ${h.sampleRate} Hz or from ${first.channels} to ${h.channels} channels part-way`,
      );
    frames.push({ start: at, end: at + h.length });
    samples += h.samples;
    at += h.length;
  }
  if (!first || !frames.length) throw new Error("it has no MP3 audio frames in it");
  return { sampleRate: first.sampleRate, channels: first.channels, frames, samples };
}

/**
 * Silence as whole frames like the one at `at`: its header without padding or CRC, and all-zero
 * side information and main data, which every decoder plays as silence.
 */
function silentFrames(b: Uint8Array, at: number, seconds: number): Uint8Array {
  const head = b.slice(at, at + 4);
  head[1] |= 1; // no CRC
  head[2] &= ~2; // no padding
  const h = header(head, 0)!;
  const count = Math.round((seconds * h.sampleRate) / h.samples);
  const out = new Uint8Array(count * h.length);
  for (let i = 0; i < count; i++) out.set(head, i * h.length);
  return out;
}

/**
 * Every part's audio frames end to end, with silence for each number of seconds in `pieces`.
 * Parts must agree on rate and channels: a player reads the whole file at the first frame's.
 */
export function joinMp3(pieces: (Uint8Array | number)[]): Uint8Array {
  const files = pieces.filter((p) => typeof p !== "number");
  const parts = files.map((f) => mp3Frames(f));
  const first = parts[0];
  if (!first) throw new Error("there was nothing to join");
  for (const [i, p] of parts.entries())
    if (p.sampleRate !== first.sampleRate || p.channels !== first.channels)
      throw new Error(
        `part ${i + 1} came back as ${p.sampleRate} Hz in ${p.channels} channels and part 1 as ${first.sampleRate} Hz in ${first.channels}`,
      );
  let file = 0;
  const spans = pieces.flatMap((p) => {
    if (typeof p === "number")
      return p > 0 ? [silentFrames(files[0], first.frames[0].start, p)] : [];
    const i = file++;
    return parts[i].frames.map((f) => files[i].subarray(f.start, f.end));
  });
  const out = new Uint8Array(spans.reduce((n, s) => n + s.byteLength, 0));
  let at = 0;
  for (const s of spans) {
    out.set(s, at);
    at += s.byteLength;
  }
  return out;
}
