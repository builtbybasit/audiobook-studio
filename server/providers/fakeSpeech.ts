// A speech provider that renders a tone and never the network.
//
// It exists so the narration job, the audio files and the route that serves them can be exercised
// end to end without a request leaving the machine. It is deterministic on its input, so a test
// can say what it will produce, and it is honest about what it is: every clip is a quiet sine tone
// whose pitch comes from the speaker's name, so two speakers sound different and nothing sounds
// like speech. The duration follows the demo simulator's reading-speed rule, so a chapter timed
// here is timed the way the seeded world times it.
//
// The file it writes is a real WAV — PCM, 8-bit, mono, 8000 Hz unless the endpoint asked for
// another rate — because the point of the fake is that a browser's audio element plays what the
// server serves, and a placeholder that only looks like a file would prove nothing about the route.
// It honours a requested rate the way a real model does, by answering at it, so a clip's recorded
// rate is read from a file that really is at that rate.
import { sleep } from "~/providers/fake";
import type { RenderedClip, SpeechInput, SpeechProvider } from "~/providers/speech";

export interface FakeSpeechOptions {
  /** a pause per line, so a test can cancel a run that is genuinely in flight */
  delayMs?: number;
  /** throw with this message instead of answering, for every line */
  failWith?: string;
  /** throw for the lines this says yes to, so a run can have one failure among successes */
  failLines?: (text: string) => boolean;
}

/** the rate it answers at when the request names none */
export const SAMPLE_RATE = 8000;
/** how far the tone swings either side of silence, out of 127; quiet on purpose */
const AMPLITUDE = 24;
/** the fake's reading speed, in words per second — the demo simulator's rule */
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

export function fakeSpeechProvider(options: FakeSpeechOptions = {}): SpeechProvider {
  return {
    name: "Fake speech (local)",
    async speak({
      text,
      speaker,
      voiceRef,
      sampleRate,
      signal,
    }: SpeechInput): Promise<RenderedClip> {
      if (options.delayMs) await sleep(options.delayMs, signal);
      if (signal.aborted) throw signal.reason;
      if (options.failWith) throw new Error(options.failWith);
      if (options.failLines?.(text)) throw new Error(`The fake could not render “${text}”`);
      const duration = fakeDuration(text);
      return {
        bytes: toneWav(toneOf(speaker), duration, sampleRate ?? SAMPLE_RATE),
        mime: "audio/wav",
        duration,
        // a made-up latency that still grows with the line, so the Queue page has something to show
        ms: Math.round((duration * 1000) / 4) + text.length,
        model: "fake-tts-1",
        voice: voiceRef ? voiceRef.slice(voiceRef.indexOf("/") + 1) : null,
      };
    },
    async probe() {
      return {
        ok: true,
        message: "The fake answers without a request: SPEECH_PROVIDER=fake",
        ms: 0,
      };
    },
  };
}
