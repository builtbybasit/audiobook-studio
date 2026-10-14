// A voice sample as the clone form trims it in the browser: decoded, speech found, cut, and
// written back as a WAV every cloning provider takes. The pure parts need no DOM.

export interface SampleAudio {
  /** mono samples, -1…1 */
  samples: Float32Array;
  sampleRate: number;
  /** seconds */
  duration: number;
}

/**
 * Web Audio resamples to its context's rate, so the context is set to the file's own rate (read
 * from its header). Fallback when the header is silent: at or above any voice recording.
 */
export const DECODE_RATE = 48_000;
const RATES = { min: 8_000, max: 96_000 };

export async function sampleRateOf(file: Blob): Promise<number> {
  try {
    const { parseBlob } = await import("music-metadata");
    const { format } = await parseBlob(file, { duration: false, skipCovers: true });
    const rate = format.sampleRate;
    return rate && rate >= RATES.min && rate <= RATES.max ? rate : DECODE_RATE;
  } catch {
    return DECODE_RATE;
  }
}

// `src/lib` is also type-checked with the server's code, which has no DOM.
declare const OfflineAudioContext: new (
  channels: number,
  length: number,
  sampleRate: number,
) => {
  decodeAudioData(data: ArrayBuffer): Promise<{
    length: number;
    numberOfChannels: number;
    sampleRate: number;
    duration: number;
    getChannelData(channel: number): Float32Array;
  }>;
};

/** Mixed to mono. Rejects when the browser cannot decode it. */
export async function decodeSample(file: File): Promise<SampleAudio> {
  // an offline context needs no user gesture; its length is only a placeholder
  const ctx = new OfflineAudioContext(1, 1, await sampleRateOf(file));
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const samples = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < samples.length; i++) samples[i]! += channel[i]! / buffer.numberOfChannels;
  }
  return { samples, sampleRate: buffer.sampleRate, duration: buffer.duration };
}

/** seconds */
const WINDOW = 0.02;
/** Loud windows in a row that count as speech, so a lone click is not. */
const RUN = 3;
/** A window is speech when it is within 26 dB of the loudest one… */
const RELATIVE = 0.05;
/** …and the loudest is above about -46 dBFS; below that the whole clip is taken as silence. */
const FLOOR = 0.005;
/** Seconds kept either side, so a breath-in or trailing consonant is not clipped. */
export const SPEECH_PADDING = 0.2;

/** Where speech starts and ends, in seconds, padded. Null when the whole clip is silence. */
export function speechBounds(audio: SampleAudio): { start: number; end: number } | null {
  const { samples, sampleRate, duration } = audio;
  const size = Math.max(1, Math.round(WINDOW * sampleRate));
  const rms: number[] = [];
  for (let at = 0; at < samples.length; at += size) {
    const end = Math.min(at + size, samples.length);
    let sum = 0;
    for (let i = at; i < end; i++) sum += samples[i]! * samples[i]!;
    rms.push(Math.sqrt(sum / (end - at)));
  }
  const loudest = rms.reduce((a, b) => Math.max(a, b), 0);
  if (loudest < FLOOR) return null;
  const loud = rms.map((r) => r >= loudest * RELATIVE);
  const need = Math.min(RUN, loud.length);
  let first = -1;
  let last = -1;
  for (let i = 0; i + need <= loud.length; i++) {
    if (!loud.slice(i, i + need).every(Boolean)) continue;
    if (first < 0) first = i;
    last = i + need - 1;
  }
  if (first < 0) return null;
  return {
    start: Math.max(0, (first * size) / sampleRate - SPEECH_PADDING),
    end: Math.min(duration, ((last + 1) * size) / sampleRate + SPEECH_PADDING),
  };
}

/** 16-bit PCM mono WAV of `samples`. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return buf;
}

/** `narrator.mp3` → `narrator-trimmed.wav`; a file trimmed again keeps the one `-trimmed`. */
export const trimmedName = (name: string): string =>
  `${name.replace(/\.[^./]*$/, "").replace(/-trimmed$/, "")}-trimmed.wav`;

/** Seconds: too short to hear, long enough to stop the click of a cut mid-wave. */
export const EDGE_FADE = 0.01;

/** `start`–`end` seconds as a WAV, its edges faded over `EDGE_FADE`. */
export function trimSample(audio: SampleAudio, start: number, end: number, name: string): File {
  const from = Math.min(Math.max(0, start), audio.duration);
  const to = Math.min(Math.max(from, end), audio.duration);
  // a copy: the decoded audio is kept for another cut
  const part = audio.samples.slice(
    Math.round(from * audio.sampleRate),
    Math.round(to * audio.sampleRate),
  );
  const fade = Math.min(Math.round(EDGE_FADE * audio.sampleRate), Math.floor(part.length / 2));
  for (let i = 0; i < fade; i++) {
    part[i]! *= i / fade;
    part[part.length - 1 - i]! *= i / fade;
  }
  return new File([encodeWav(part, audio.sampleRate)], trimmedName(name), { type: "audio/wav" });
}
