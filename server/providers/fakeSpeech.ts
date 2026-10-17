// A speech provider that renders a quiet sine tone, pitched by speaker, and never the network; also
// what a simulated endpoint answers with (`speakTone`, `simulatedSpeech.ts`). The file is a real
// 8-bit mono WAV, at the requested rate, so the serving route is really exercised. It answers WAV
// whatever format is asked for, and says so. Every line is reported through `sent` as simulated.
import { AUDIO_MIME } from "@/lib/endpointShapes";
import type { AnsweredAudio } from "~/providers/answer";
import { sleep } from "~/providers/fake";
import type { SentSpeech } from "~/providers/sent";
import { ProviderError } from "~/providers/http";
import {
  BatchCut,
  type BatchLimits,
  type RenderedClip,
  type SpeechInput,
  type SpeechProvider,
} from "~/providers/speech";

export interface FakeSpeechOptions {
  /** per line, so a test can cancel a run in flight */
  delayMs?: number;
  /** throw this for every line */
  failWith?: string;
  /** throw for the lines this says yes to */
  failLines?: (text: string) => boolean;
  /** batch as `docs/speech-batch-api.md` does, answering last first to catch order assumptions */
  batch?: BatchLimits;
  /** in a batch, fail these as retryable the first time each is seen */
  retryLines?: (text: string) => boolean;
  /** in a batch, answer this many items and then drop the connection, once */
  dropAfter?: number;
  /** each batch's texts, as sent */
  batches?: string[][];
}

export const SAMPLE_RATE = 8000;
/** out of 127; quiet on purpose */
const AMPLITUDE = 24;
/** the seeded world's reading-speed rule */
const WORDS_PER_SECOND = 2.6;
const MIN_SECONDS = 0.4;

export function fakeDuration(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_SECONDS, words / WORDS_PER_SECOND);
}

/** 180–440 Hz, stable per name. */
export function toneOf(speaker: string): number {
  let h = 0;
  for (const ch of speaker) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return 180 + (h % 260);
}

/** 8-bit unsigned PCM, mono. */
export function toneWav(hz: number, seconds: number, rate: number = SAMPLE_RATE): Uint8Array {
  const samples = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // the fmt chunk's own length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true); // bytes per second: one byte per sample
  view.setUint16(32, 1, true); // bytes per frame
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  // 8-bit WAV is unsigned: silence is 128
  for (let i = 0; i < samples; i++)
    bytes[44 + i] = 128 + Math.round(AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / rate));
  return bytes;
}

/** Shared by the fake and `simulatedSpeech.ts`. A `failure` is reported unbilled and thrown. */
export function speakTone(input: SpeechInput, startedAt: number, failure?: Error): AnsweredAudio {
  const { text, speaker, instructions, sampleRate, sent } = input;
  const report = (rest: Pick<SentSpeech, "status" | "audioSeconds" | "error" | "billed">): void =>
    sent?.({
      startedAt,
      finishedAt: Date.now(),
      attempts: 1,
      rateLimited: false,
      simulated: true,
      text,
      instructions: instructions.trim(),
      reported: null,
      ...rest,
    });
  if (failure) {
    report({
      status: "failed",
      audioSeconds: 0,
      error: {
        code: failure instanceof ProviderError ? failure.status : 0,
        message: failure.message,
      },
      billed: false,
    });
    throw failure;
  }
  const duration = fakeDuration(text) / (input.speed ?? 1);
  report({ status: "done", audioSeconds: duration, billed: true });
  return {
    bytes: toneWav(toneOf(speaker), duration, sampleRate ?? SAMPLE_RATE),
    format: "wav",
    mime: AUDIO_MIME.wav,
    duration,
  };
}

export function fakeSpeechProvider(options: FakeSpeechOptions = {}): SpeechProvider {
  const retried = new Set<string>();
  let dropped = false;
  const provider: SpeechProvider = {
    name: "Fake speech (local)",
    async speak(input: SpeechInput): Promise<RenderedClip> {
      const { text, voiceRef, signal } = input;
      const startedAt = Date.now();
      if (options.delayMs) await sleep(options.delayMs, signal);
      if (signal.aborted) throw signal.reason;
      const failure =
        options.failWith ??
        (options.failLines?.(text) ? `The fake could not render “${text}”` : null);
      const audio = speakTone(input, startedAt, failure ? new Error(failure) : undefined);
      return {
        ...audio,
        // made up, but growing with the line
        ms: Math.round((audio.duration * 1000) / 4) + text.length,
        model: "fake-tts-1",
        voice: voiceRef ? voiceRef.slice(voiceRef.indexOf("/") + 1) : null,
      };
    },
    async probe() {
      return { ok: true, message: "The fake answers without a request", ms: 0 };
    },
  };
  const { batch } = options;
  if (!batch) return provider;
  return {
    ...provider,
    capabilities: async () => ({ limits: batch, speed: null }),
    async speakBatch({ items, signal, answered }) {
      options.batches?.push(items.map((i) => i.text));
      if (options.delayMs) await sleep(options.delayMs, signal);
      let told = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        if (signal.aborted) throw signal.reason;
        if (options.dropAfter != null && !dropped && told === options.dropAfter) {
          dropped = true;
          throw new BatchCut("The fake dropped the connection part-way");
        }
        const item = items[i];
        told++;
        if (options.retryLines?.(item.text) && !retried.has(item.text)) {
          retried.add(item.text);
          answered(i, { error: new ProviderError(`The fake fumbled “${item.text}”`, 0, true) });
          continue;
        }
        try {
          answered(i, { clip: await provider.speak({ ...item, signal }) });
        } catch (e) {
          if (signal.aborted) throw e;
          answered(i, { error: e as Error });
        }
      }
    },
  };
}
