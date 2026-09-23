// Choosing what a speech endpoint is asked for — its format, bitrate and rate — without ever
// leaving a combination the provider would refuse.
//
// `endpointShapes.ts` says what each API can be asked for and why a combination is wrong; this file
// is what the page does about it. Three things move the ground under a saved choice: picking another
// format, picking another rate, and saving a base URL that speaks a different API (Fish Audio's
// formats are not OpenAI's). Each goes through `repairEncoding`, which keeps what is still allowed,
// puts back what is not, and says what it put back — so the page can tell the person instead of the
// server refusing the next line.
import { FORMAT_LABEL, encodingOf, speechFormats } from "@/lib/endpointShapes";
import type { FormatSupport } from "@/lib/endpointShapes";
import { sampleRateLabel } from "@/lib/speech";
import type { AudioEncoding, AudioFormat, Endpoint, SampleRate } from "@/types";

/** The fields that decide what a line is asked for. */
export type EncodingFields = Pick<Endpoint, "baseUrl" | "encoding" | "sampleRate">;

export interface EncodingRepair {
  /** null when the endpoint asks for WAV at the provider's bitrate — what an absent choice means */
  encoding: AudioEncoding | null;
  sampleRate: SampleRate | null;
  /** one sentence per thing that had to be put back; empty when the choice stood as it was */
  notes: string[];
}

/** What this endpoint's API offers for the format it is set to, if it offers that format at all. */
export const supportOf = (e: EncodingFields): FormatSupport | undefined =>
  speechFormats(e).find((f) => f.format === encodingOf(e).format);

/** A bitrate as the page says it: MP3's are kbps, Opus's bps, and -1000 is Opus's automatic. */
export function bitrateLabel(format: AudioFormat, bitrate: number): string {
  if (format === "opus" && bitrate === -1000) return "Automatic";
  return `${format === "opus" ? bitrate / 1000 : bitrate} kbps`;
}

/**
 * The endpoint's choice made valid for its base URL, optionally switching to `format` first.
 *
 * What is still allowed is kept — a bitrate or rate the new format also offers carries over — and
 * what is not is put back to the provider's own default rather than to some other value on the
 * list, because the default is the one choice that is always valid and never a surprise. A format
 * the API does not offer at all falls back to WAV, which every speech API here can return.
 */
export function repairEncoding(e: EncodingFields, format?: AudioFormat): EncodingRepair {
  const notes: string[] = [];
  const formats = speechFormats(e);
  let want = format ?? encodingOf(e).format;
  let bitrate = encodingOf(e).bitrate;
  let support = formats.find((f) => f.format === want);
  if (!support) {
    notes.push(`This API cannot be asked for ${FORMAT_LABEL[want]}, so it is back to WAV.`);
    want = "wav";
    bitrate = undefined;
    support = formats.find((f) => f.format === "wav")!;
  }
  if (bitrate != null && !support.bitrates.some((b) => b.value === bitrate)) {
    const fallback =
      support.defaultBitrate != null
        ? `the provider's default (${bitrateLabel(want, support.defaultBitrate)})`
        : "none";
    notes.push(
      support.bitrates.length
        ? `${FORMAT_LABEL[want]} here has no ${bitrateLabel(encodingOf(e).format, bitrate)}; the bitrate is ${fallback}.`
        : `${FORMAT_LABEL[want]} here takes no bitrate, so ${bitrateLabel(encodingOf(e).format, bitrate)} was dropped.`,
    );
    bitrate = undefined;
  }
  let sampleRate = e.sampleRate ?? null;
  if (sampleRate != null) {
    if (!support.rates) {
      notes.push(
        `This API cannot be asked for a sample rate, so ${sampleRateLabel(sampleRate)} was cleared; it answers at the model's own.`,
      );
      sampleRate = null;
    } else if (!support.rates.includes(sampleRate)) {
      notes.push(
        `${FORMAT_LABEL[want]} here has no ${sampleRateLabel(sampleRate)}; the rate is the provider's default${support.defaultRate ? ` (${sampleRateLabel(support.defaultRate)})` : ""}.`,
      );
      sampleRate = null;
    }
  }
  // WAV at no bitrate is what an absent choice already means, so it is stored as nothing: an
  // endpoint that never touched the picker and one that went back to WAV read the same.
  const encoding: AudioEncoding | null =
    want === "wav" && bitrate == null
      ? null
      : { format: want, ...(bitrate != null ? { bitrate } : {}) };
  return { encoding, sampleRate, notes };
}

/** Whether a repair would change what the endpoint holds — the page writes only when it does. */
export function encodingChanged(e: EncodingFields, r: EncodingRepair): boolean {
  const norm = (x: AudioEncoding | null | undefined) =>
    x == null || (x.format === "wav" && x.bitrate == null) ? null : x;
  const a = norm(e.encoding);
  const b = norm(r.encoding);
  const same =
    a === b || (a != null && b != null && a.format === b.format && a.bitrate === b.bitrate);
  return !same || (e.sampleRate ?? null) !== r.sampleRate;
}

/** Opus's automatic bitrate is the encoder's to pick; Fish's own prose puts it near 32 kbps. */
const OPUS_AUTO_KBPS = 32;

export interface SizePerMinute {
  bytes: number;
  /** true when a figure had to be assumed (Opus's automatic bitrate) */
  approx: boolean;
  /** what the figure was worked out from, e.g. "44.1 kHz, 16-bit mono" */
  basis: string;
}

/**
 * Roughly how much one minute of speech takes in this format, or null when the API does not say
 * what it answers at (OpenAI's rate and bitrate are the model's own). WAV is the rate times two
 * bytes, since every WAV here is 16-bit mono; a compressed format is its bitrate over eight.
 */
export function sizePerMinute(e: EncodingFields): SizePerMinute | null {
  const support = supportOf(e);
  if (!support) return null;
  const { format, bitrate } = encodingOf(e);
  if (format === "wav") {
    const rate = e.sampleRate ?? support.defaultRate;
    if (!rate) return null;
    return { bytes: rate * 2 * 60, approx: false, basis: `${sampleRateLabel(rate)}, 16-bit mono` };
  }
  const b = bitrate ?? support.defaultBitrate;
  if (b == null) return null;
  const auto = format === "opus" && b === -1000;
  const kbps = auto ? OPUS_AUTO_KBPS : format === "opus" ? b / 1000 : b;
  return {
    bytes: (kbps * 1000 * 60) / 8,
    approx: auto,
    basis: auto ? `automatic, taken as ~${OPUS_AUTO_KBPS} kbps` : `${kbps} kbps`,
  };
}

/** 2_646_000 → "2.6 MB", 960_000 → "960 KB". Decimal units, as a file manager shows them. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e6) return `${Number((bytes / 1e6).toFixed(1))} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** One line for a request summary: "MP3 · 128 kbps · 44.1 kHz", "WAV · model's rate". */
export function encodingSummary(e: EncodingFields): string {
  const { format, bitrate } = encodingOf(e);
  const support = supportOf(e);
  const parts: string[] = [FORMAT_LABEL[format]];
  const b = bitrate ?? support?.defaultBitrate;
  if (b != null) parts.push(bitrateLabel(format, b));
  const rate = e.sampleRate ?? support?.defaultRate;
  parts.push(rate ? sampleRateLabel(rate) : "model's rate");
  return parts.join(" · ");
}
