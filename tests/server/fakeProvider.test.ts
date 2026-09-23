// The fake providers: deterministic, honest about what they are, and abortable. The scripting
// fake attributes lines from punctuation; the speech fake renders a tone into a real WAV file.
import { describe, expect, test } from "bun:test";

import { attributeParagraph, fakeScriptingProvider, UNKNOWN_SPEAKER } from "~/providers/fake";
import { fakeDuration, fakeSpeechProvider, SAMPLE_RATE, toneOf } from "~/providers/fakeSpeech";
import type { SpeechInput } from "~/providers/speech";

describe("attributing a paragraph", () => {
  test("narration stays with the narrator and a quote becomes dialogue", () => {
    // the tag stays in the narration: a narrator reads "said Mara" out loud
    expect(attributeParagraph("The door opened. “Come in,” said Mara. He did.")).toEqual([
      { type: "narration", speaker: "Narrator", text: "The door opened." },
      { type: "dialogue", speaker: "Mara", text: "Come in," },
      { type: "narration", speaker: "Narrator", text: "said Mara. He did." },
    ]);
  });

  test("a speaker named before the verb is found too, and two names are kept together", () => {
    const [line] = attributeParagraph('"We leave at dawn." Old Tobiah muttered it twice.');
    expect(line).toEqual({ type: "dialogue", speaker: "Old Tobiah", text: "We leave at dawn." });
  });

  test("a quote with nobody named beside it is not guessed at", () => {
    expect(attributeParagraph("“Who goes there?”")).toEqual([
      { type: "dialogue", speaker: UNKNOWN_SPEAKER, text: "Who goes there?" },
    ]);
  });

  test("a paragraph with no quotes is one narration line", () => {
    expect(attributeParagraph("Rain fell all night.")).toHaveLength(1);
  });
});

describe("the provider", () => {
  test("reports progress a paragraph at a time and answers the same way twice", async () => {
    const provider = fakeScriptingProvider();
    const text = "One.\n\nTwo.\n\n“Three,” said Ann.";
    const seen: [number, number][] = [];
    const first = await provider.script({
      title: "t",
      target: null,
      cast: [],
      text,
      signal: new AbortController().signal,
      progress: (d, t) => seen.push([d, t]),
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    const second = await provider.script({
      title: "t",
      target: null,
      cast: [],
      text,
      signal: new AbortController().signal,
    });
    expect(second).toEqual(first);
  });

  test("stops when the signal is aborted mid-run", async () => {
    const provider = fakeScriptingProvider();
    const controller = new AbortController();
    const run = provider.script({
      title: "t",
      target: null,
      cast: [],
      text: "One.\n\nTwo.\n\nThree.",
      signal: controller.signal,
      progress: () => controller.abort(new DOMException("stop", "AbortError")),
    });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

const line = (text: string, speaker = "Mara", extra: Partial<SpeechInput> = {}): SpeechInput => ({
  text,
  speaker,
  type: "dialogue",
  direction: "",
  instructions: "",
  voiceRef: null,
  sampleRate: null,
  encoding: { format: "wav" },
  target: null,
  signal: new AbortController().signal,
  ...extra,
});

describe("the fake speech model", () => {
  test("writes a WAV file whose header describes the bytes that follow it", async () => {
    const clip = await fakeSpeechProvider().speak(
      line("We are short again, and the rain has not stopped."),
    );
    const { bytes } = clip;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (at: number) => new TextDecoder().decode(bytes.slice(at, at + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(ascii(36)).toBe("data");
    const data = view.getUint32(40, true);
    expect(data).toBe(bytes.length - 44);
    expect(view.getUint32(4, true)).toBe(36 + data);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(8); // bits per sample
    // exactly as many samples as the duration says, at the rate the header says
    expect(data).toBe(Math.round(clip.duration * SAMPLE_RATE));
    expect(clip.mime).toBe("audio/wav");
    expect(clip.model).toBe("fake-tts-1");
    // a quiet tone: every sample near silence, and not all of them silence
    expect(bytes.slice(44).every((b) => b >= 100 && b <= 156)).toBe(true);
    expect(new Set(bytes.slice(44)).size).toBeGreaterThan(2);
  });

  test("answers at the rate it is asked for, with as many samples as the line lasts", async () => {
    for (const rate of [16000, 44100, 48000]) {
      const clip = await fakeSpeechProvider().speak(
        line("Then we count it twice.", "Tobin", { sampleRate: rate }),
      );
      const view = new DataView(clip.bytes.buffer, clip.bytes.byteOffset, clip.bytes.byteLength);
      expect(view.getUint32(24, true)).toBe(rate);
      expect(view.getUint32(28, true)).toBe(rate); // bytes per second, at one byte a sample
      expect(view.getUint32(40, true)).toBe(Math.round(clip.duration * rate));
    }
  });

  test("times a line by its words, and never shorter than a breath", async () => {
    expect(
      fakeDuration("one two three four five six seven eight nine ten eleven twelve thirteen"),
    ).toBeCloseTo(13 / 2.6);
    expect(fakeDuration("Yes.")).toBe(0.4);
    // whitespace is not words
    expect(fakeDuration("  spaced   out  ")).toBe(fakeDuration("spaced out"));
    const clip = await fakeSpeechProvider().speak(line("Yes."));
    expect(clip.duration).toBe(0.4);
    expect(clip.ms).toBe(100 + 4);
  });

  test("answers the same bytes for the same line, and a different tone for another speaker", async () => {
    const provider = fakeSpeechProvider();
    const a = await provider.speak(line("Count it twice."));
    const b = await provider.speak(line("Count it twice."));
    expect(b.bytes).toEqual(a.bytes);
    expect(toneOf("Mara")).not.toBe(toneOf("Tobin"));
    const c = await provider.speak(line("Count it twice.", "Tobin"));
    expect(c.bytes).not.toEqual(a.bytes);
    expect(c.bytes.length).toBe(a.bytes.length);
  });

  test("names the voice it was asked for, from the voice half of the ref", async () => {
    const provider = fakeSpeechProvider();
    expect((await provider.speak(line("x", "Mara", { voiceRef: "ep-1/alloy" }))).voice).toBe(
      "alloy",
    );
    expect((await provider.speak(line("x"))).voice).toBeNull();
  });

  test("answers a cancelled request with the cancel, not a clip", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const run = fakeSpeechProvider().speak(line("Slow.", "Mara", { signal: controller.signal }));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});
