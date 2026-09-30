// A speech provider that renders a tone and never the network.
//
// It exists so the narration job, the audio files and the route that serves them can be exercised
// end to end without a request leaving the machine. The tests hand it to the server in place of
// the real provider; a person who wants the same sets an endpoint to simulated, and the real
// provider answers that with this tone (`speakTone`, `simulatedSpeech.ts`). It is deterministic on
// its input, so a test can say what it will produce, and it is honest about what it is: every clip
// is a quiet sine tone whose pitch comes from the speaker's name, so two speakers sound different
// and nothing sounds like speech. The duration follows the seeded world's reading-speed rule, so a
// chapter timed here is timed the way the seeded world times it.
//
// The file it writes is a real WAV — PCM, 8-bit, mono, 8000 Hz unless the endpoint asked for
// another rate — because the point of the fake is that a browser's audio element plays what the
// server serves, and a placeholder that only looks like a file would prove nothing about the route.
// It honours a requested rate the way a real model does, by answering at it, so a clip's recorded
// rate is read from a file that really is at that rate.
//
// It does not honour a requested format. An MP3 or Opus encoder is not something to write by hand
// for a tone, and the fake stays free of the network and of binaries, so it answers WAV whatever
// the endpoint asks for and says so on the clip (`format: "wav"`). The job keeps a clip as the
// format it says it is, so a fake run on an MP3 endpoint writes `.wav` files, which every part of
// the server reads — the format a clip is in is never drift.
//
// It reports every line it is asked for through `sent`, as a real provider reports a request,
// marked `simulated` so nobody reads the row as a bill: that is what lets a run against a priced
// endpoint be metered and held to a cap without spending anything. A line it was told to fail is
// reported failed and not billed, the way a request refused on the wire is; a cancel reports
// nothing.
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
  /** a pause per line, so a test can cancel a run that is genuinely in flight */
  delayMs?: number;
  /** throw with this message instead of answering, for every line */
  failWith?: string;
  /** throw for the lines this says yes to, so a run can have one failure among successes */
  failLines?: (text: string) => boolean;
  /**
   * Take lines in batches of this size, as a server that answers `docs/speech-batch-api.md`
   * would: each item rendered as a line is, and answered last first, so a caller that assumes
   * the order it sent in is caught out.
   */
  batch?: BatchLimits;
  /**
   * In a batch, fail the items this says yes to as worth another try, the first time each is
   * seen — a render that went wrong on the server, say.
   */
  retryLines?: (text: string) => boolean;
  /** In a batch, answer this many items and then drop the connection, once. */
  dropAfter?: number;
  /** told of every batch as it is sent: how many items, and their texts */
  batches?: string[][];
}

/** the rate it answers at when the request names none */
export const SAMPLE_RATE = 8000;
/** how far the tone swings either side of silence, out of 127; quiet on purpose */
const AMPLITUDE = 24;
/** the fake's reading speed, in words per second — the seeded world's rule */
const WORDS_PER_SECOND = 2.6;
const MIN_SECONDS = 0.4;

/** How long the fake takes to say a line: never shorter than a breath, however short the line. */
export function fakeDuration(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_SECONDS, words / WORDS_PER_SECOND);
}

/** A pitch for a speaker, between 180 and 440 Hz, the same every time for the same name. */
export function toneOf(speaker: string): number {
  let h = 0;
  for (const ch of speaker) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return 180 + (h % 260);
}

/** A RIFF/WAVE file holding `seconds` of a sine tone at `hz`: 8-bit unsigned PCM, mono. */
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
  // 8-bit WAV is unsigned: silence is 128, and the tone swings a little either side of it
  for (let i = 0; i < samples; i++)
    bytes[44 + i] = 128 + Math.round(AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / rate));
  return bytes;
}

/**
 * One line said as a tone: as long as the line takes to read, at the rate the line asks for, and
 * reported through `sent` as simulated — or, given a `failure`, reported failed and not billed, the
 * way a request refused on the wire is, and thrown. What the fake and a simulated endpoint
 * (`simulatedSpeech.ts`) have in common; when each waits and which lines each fails are its own.
 */
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
  const duration = fakeDuration(text);
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
        // a made-up latency that still grows with the line, so the Queue page has something to show
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
    batchLimits: async () => batch,
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
