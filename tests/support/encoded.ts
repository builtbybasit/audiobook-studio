// MP3 and Ogg Opus files built in the test, so no binary fixture has to be kept and none has to
// come from anywhere.
//
// Neither is made by an encoder. An MP3 Layer III frame whose side information and main data are
// all zero is a frame of silence every decoder plays — it is the first frame Fish Audio's own MP3
// starts with — so a file of them is a real, playable MP3 of an exact length. An Ogg Opus file is
// pages of packets under an `OpusHead` and an `OpusTags` header, each page with its CRC; its length
// is the last page's granule position less the pre-skip, which is what a reader times it by. Its
// packets are the one-byte "no data" frame Opus allows, which a decoder conceals as silence.

export interface Mp3Options {
  /** 44100 (default), 48000 or 32000: MPEG-1 */
  rate?: 44100 | 48000 | 32000;
  /** kbps, one of MPEG-1 Layer III's; 128 by default */
  kbps?: 64 | 128 | 192;
  /** an encoder's `Info` frame first, saying how many frames follow, as LAME writes one */
  info?: boolean;
  /** an ID3v2.3 tag first, with a title in it */
  id3?: boolean;
  /** an ID3v1 tag last */
  id3v1?: boolean;
}

const RATE_INDEX = { 44100: 0, 48000: 1, 32000: 2 } as const;
const KBPS_INDEX = { 64: 5, 128: 9, 192: 11 } as const;

/** Samples in one MPEG-1 Layer III frame. */
export const MP3_FRAME = 1152;

/** An MP3 of `frames` frames of silence, mono: `frames × 1152 ÷ rate` seconds long. */
export function silentMp3(frames: number, o: Mp3Options = {}): Uint8Array {
  const rate = o.rate ?? 44100;
  const kbps = o.kbps ?? 128;
  const size = Math.floor((144000 * kbps) / rate);
  const frame = (): Uint8Array => {
    const f = new Uint8Array(size);
    f.set([0xff, 0xfb, (KBPS_INDEX[kbps] << 4) | (RATE_INDEX[rate] << 2), 0xc4]);
    return f;
  };
  const parts: Uint8Array[] = [];
  if (o.id3) {
    const title = new TextEncoder().encode("\u0000A line");
    const body = new Uint8Array(10 + title.length + 20);
    body.set(new TextEncoder().encode("TIT2"));
    new DataView(body.buffer).setUint32(4, title.length);
    body.set(title, 10);
    const head = new Uint8Array(10);
    head.set([0x49, 0x44, 0x33, 3, 0, 0]);
    // a syncsafe size: seven bits a byte
    const n = body.length;
    head.set([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f], 6);
    parts.push(head, body);
  }
  if (o.info) {
    const f = frame();
    // after the header and 17 bytes of mono side information: the tag, its flags, and the counts
    const view = new DataView(f.buffer);
    f.set(new TextEncoder().encode("Info"), 21);
    view.setUint32(25, 3);
    view.setUint32(29, frames);
    view.setUint32(33, frames * size);
    parts.push(f);
  }
  for (let i = 0; i < frames; i++) parts.push(frame());
  if (o.id3v1) {
    const tag = new Uint8Array(128);
    tag.set(new TextEncoder().encode("TAGA line"));
    parts.push(tag);
  }
  return concat(parts);
}

/** An Ogg Opus file, mono, of `packets` 20 ms packets: `packets ÷ 50` seconds long. */
export function oggOpus(packets: number, preSkip = 312): Uint8Array {
  const serial = 0x5eed;
  const pages: Uint8Array[] = [];
  let seq = 0;
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  const hv = new DataView(head.buffer);
  head[8] = 1; // version
  head[9] = 1; // channels
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, 48000, true);
  pages.push(oggPage([head], 0n, serial, seq++, 0x02));
  const vendor = new TextEncoder().encode("tests");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  pages.push(oggPage([tags], 0n, serial, seq++, 0));
  // TOC 0xF8: CELT, fullband, 20 ms, mono, one frame — of no bytes, which a decoder conceals
  const perPage = 50;
  for (let done = 0; done < packets;) {
    const n = Math.min(perPage, packets - done);
    done += n;
    const granule = BigInt(preSkip + done * 960);
    const last = done === packets;
    pages.push(
      oggPage(
        Array.from({ length: n }, () => new Uint8Array([0xf8])),
        granule,
        serial,
        seq++,
        last ? 0x04 : 0,
      ),
    );
  }
  return concat(pages);
}

function oggPage(
  packets: Uint8Array[],
  granule: bigint,
  serial: number,
  seq: number,
  type: number,
): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let left = p.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const body = concat(packets);
  const page = new Uint8Array(27 + lacing.length + body.length);
  const v = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"));
  page[5] = type;
  v.setBigUint64(6, granule, true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(body, 27 + lacing.length);
  v.setUint32(22, oggCrc(page), true);
  return page;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});

/** Ogg's CRC-32: polynomial 0x04C11DB7, not reflected, over the page with its CRC field zero. */
function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const b of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
