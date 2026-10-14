// Keeping a speech endpoint's format, bitrate and rate a combination its provider takes. Every
// change (format, rate, base URL) goes through `repairEncoding`, which says what it put back.
// What each API allows is in `endpointShapes.ts`.
import { FORMAT_LABEL, encodingOf, speechFormats } from "@/lib/endpointShapes";
import type { FormatSupport } from "@/lib/endpointShapes";
import { sampleRateLabel } from "@/lib/speech";
import type { AudioEncoding, AudioFormat, Endpoint, SampleRate } from "@/types";

export type EncodingFields = Pick<Endpoint, "baseUrl" | "encoding" | "sampleRate">;

export interface EncodingRepair {
  /** null for WAV at the provider's defaults, what an absent choice means */
  encoding: AudioEncoding | null;
  sampleRate: SampleRate | null;
  /** one sentence per thing put back */
  notes: string[];
}

export const supportOf = (e: EncodingFields): FormatSupport | undefined =>
  speechFormats(e).find((f) => f.format === encodingOf(e).format);

/** MP3's are kbps, Opus's bps, and -1000 is Opus's automatic. */
export function bitrateLabel(format: AudioFormat, bitrate: number): string {
  if (format === "opus" && bitrate === -1000) return "Automatic";
  return `${format === "opus" ? bitrate / 1000 : bitrate} kbps`;
}

/**
 * The choice made valid for its base URL, optionally switching to `format`. What is allowed is
 * kept; the rest goes back to the provider's default. An unoffered format falls back to WAV.
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
  // WAV at no bitrate is stored as nothing, the same as never touching the picker
  const encoding: AudioEncoding | null =
    want === "wav" && bitrate == null
      ? null
      : { format: want, ...(bitrate != null ? { bitrate } : {}) };
  return { encoding, sampleRate, notes };
}

/** The page writes only when it does. */
export function encodingChanged(e: EncodingFields, r: EncodingRepair): boolean {
  const norm = (x: AudioEncoding | null | undefined) =>
    x == null || (x.format === "wav" && x.bitrate == null) ? null : x;
  const a = norm(e.encoding);
  const b = norm(r.encoding);
  const same =
    a === b || (a != null && b != null && a.format === b.format && a.bitrate === b.bitrate);
  return !same || (e.sampleRate ?? null) !== r.sampleRate;
}

/** Opus's automatic bitrate; Fish's docs put it near 32 kbps. */
const OPUS_AUTO_KBPS = 32;

export interface SizePerMinute {
  bytes: number;
  /** Opus's automatic bitrate had to be assumed */
  approx: boolean;
  /** e.g. "44.1 kHz, 16-bit mono" */
  basis: string;
}

/** Null when the API does not say what it answers at (OpenAI's are the model's own). */
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

/** 2_646_000 → "2.6 MB", 960_000 → "960 KB". Decimal units. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e6) return `${Number((bytes / 1e6).toFixed(1))} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** "MP3 · 128 kbps · 44.1 kHz", "WAV · model's rate" */
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
