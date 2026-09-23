// An MP3 read as the frames it is made of, so a line sent in parts can be put back together.
//
// An MP3 file is a run of self-contained frames, each with a four-byte header saying how long it
// is. That makes joining two of them a matter of laying one run of frames after the other, with no
// decoding. The rest of a file has to go, though: an ID3 tag at the start or end would sit in the
// middle of the joined audio, and a Xing, Info or VBRI frame — a silent first frame an encoder
// writes to say how many frames follow — would tell a player the joined file is as long as its
// first part. So the join keeps audio frames only, from every part, the first one included. What
// comes out is a plain frame stream with no header of its own, which is how Fish Audio sends MP3
// in the first place, and a player times it by counting or by its constant bitrate.
//
// The same walk is how long an MP3 plays: frames × samples per frame ÷ rate. `music-metadata` reads
// a constant-bitrate MP3's length off the file size and a rounded frame size instead, which drifts
// by a frame every few minutes; counting is exact, and cheap for a line.
//
// Only Layer III is read: it is what "MP3" means, and what every speech API sends. A torn last
// frame — a stream cut short — is left out rather than counted.

/** One MP3 file as its audio frames: where each is, and what they all are. */
export interface Mp3Frames {
  sampleRate: number;
  channels: number;
  /** each audio frame's byte span; the Xing, Info or VBRI frame and any tag are not among them */
  frames: { start: number; end: number }[];
  /** audio samples per channel, which is what a duration is counted from */
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

/** The frame header at `at`, or null when there is not one there. */
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

/** Whether the frame at `at` is an encoder's Xing, Info or VBRI frame rather than audio. */
function isInfoFrame(b: Uint8Array, at: number, h: FrameHeader): boolean {
  const tag = ascii(b, h.infoAt, 4);
  return tag === "Xing" || tag === "Info" || ascii(b, at + 36, 4) === "VBRI";
}

/** Past every ID3v2 tag at `at`: ten bytes, a syncsafe size, and ten more when it has a footer. */
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

/**
 * Where the next frame starts at or after `at`: the first header followed by another header or by
 * the end of the file, so a stray 0xFF in some junk is not taken for one. -1 when there is none.
 */
function resync(b: Uint8Array, at: number): number {
  for (let i = at; i + 4 <= b.byteLength; i++) {
    const h = header(b, i);
    if (h && (i + h.length === b.byteLength || header(b, i + h.length))) return i;
  }
  return -1;
}

/**
 * The audio frames of an MP3. Throws, saying why, when it has none — an answer that is not an MP3
 * is not a clip — or when its frames change rate or channels part-way, which no player follows.
 */
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
 * Several MP3 files as one: every part's audio frames end to end, with no tag and no Xing frame
 * from any of them. The parts have to agree on rate and channels — a player reads the whole file
 * at the first frame's — and a part that does not is named by its place.
 */
export function joinMp3(files: Uint8Array[]): Uint8Array {
  const parts = files.map((f) => mp3Frames(f));
  const first = parts[0];
  if (!first) throw new Error("there was nothing to join");
  for (const [i, p] of parts.entries())
    if (p.sampleRate !== first.sampleRate || p.channels !== first.channels)
      throw new Error(
        `part ${i + 1} came back as ${p.sampleRate} Hz in ${p.channels} channels and part 1 as ${first.sampleRate} Hz in ${first.channels}`,
      );
  const length = parts.reduce((n, p) => n + p.frames.reduce((a, f) => a + f.end - f.start, 0), 0);
  const out = new Uint8Array(length);
  let at = 0;
  for (const [i, p] of parts.entries())
    for (const f of p.frames) {
      out.set(files[i].subarray(f.start, f.end), at);
      at += f.end - f.start;
    }
  return out;
}
