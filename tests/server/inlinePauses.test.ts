// Pauses inside a line on the server: a line its voice has no pause tag for, spoken in parts and
// joined into one clip with the pause's silence between them, in WAV and MP3; Opus refused before
// anything is sent; and a new length for the book's pauses staling the clips of the lines that hold
// one, and no others.
import { describe, expect, test } from "bun:test";

import type { AudioFormat } from "@/types";
import { pauseAnnotation } from "@/lib/expressions";
import { DEFAULT_PACING } from "@/lib/speech";
import type { SplitPart } from "@/lib/split";
import { probeClip } from "~/audio/probe";
import { readScript, writeScript } from "~/db/script";
import { speakInParts } from "~/narration/parts";
import type { RenderedClip, SpeechInput, SpeechProvider } from "~/providers/speech";
import { wavHeader } from "~/providers/wav";
import { MP3_FRAME, silentMp3 } from "../support/encoded";
import { story } from "../support/epub";
import { jsonBody, narrateChapters, speechEndpoint, testApi, voicedBook } from "../support/server";

const RATE = 24000;
/** half a second of 16-bit mono WAV, not silent, so the silence put between is told apart */
const halfSecond = (): Uint8Array => {
  const samples = new Uint8Array(RATE).fill(7);
  const out = new Uint8Array(44 + samples.length);
  out.set(wavHeader({ channels: 1, sampleRate: RATE, bits: 16 }, samples.length));
  out.set(samples, 44);
  return out;
};

/** A provider answering every part with `bytes`, and keeping the texts it was sent. */
function answering(format: AudioFormat, bytes: () => Uint8Array, duration: number) {
  const texts: string[] = [];
  const provider: SpeechProvider = {
    name: "test",
    speak: async (input): Promise<RenderedClip> => {
      texts.push(input.text);
      return { bytes: bytes(), format, mime: "", duration, ms: 1, model: "m", voice: null };
    },
  };
  return { provider, texts };
}

const input = (format: AudioFormat): SpeechInput => ({
  text: "Well. I suppose so.",
  speaker: "Mara",
  type: "dialogue",
  direction: "",
  instructions: "",
  voiceRef: null,
  sampleRate: null,
  encoding: { format },
  target: null,
  signal: new AbortController().signal,
});

const cuts: SplitPart[] = [
  { text: "Well. ", from: 0, to: 6, at: null, fallback: false, before: 0.4, after: 1 },
  { text: "I suppose so.", from: 6, to: 19, at: null, fallback: false },
];

describe("a line spoken in parts at its pauses", () => {
  test("WAV parts are joined with the silence before, between and after them", async () => {
    const { provider, texts } = answering("wav", halfSecond, 0.5);
    const clip = await speakInParts(provider, input("wav"), cuts);
    expect(texts).toEqual(["Well.", "I suppose so."]);
    expect(clip.duration).toBeCloseTo(2.4, 6);
    expect((await probeClip(clip.bytes, "wav")).duration).toBeCloseTo(2.4, 6);
    // the silence is zeros, where the parts are not
    expect(clip.bytes[44 + 2]).toBe(0);
    expect(clip.bytes[44 + 0.4 * RATE * 2 + 2]).toBe(7);
  });

  test("MP3 parts are joined with whole frames of silence", async () => {
    const { provider } = answering("mp3", () => silentMp3(10), (10 * MP3_FRAME) / 44100);
    const clip = await speakInParts(provider, input("mp3"), [
      { ...cuts[0], before: undefined },
      cuts[1],
    ]);
    const frames = 20 + Math.round(44100 / MP3_FRAME);
    expect((await probeClip(clip.bytes, "mp3")).duration).toBeCloseTo(
      (frames * MP3_FRAME) / 44100,
      6,
    );
  });

  test("one part with a pause at its end is still joined; in Opus it is refused unsent", async () => {
    const one: SplitPart[] = [{ ...cuts[1], from: 0, after: 0.5 }];
    const { provider, texts } = answering("wav", halfSecond, 0.5);
    expect((await speakInParts(provider, input("wav"), one)).duration).toBeCloseTo(1, 6);
    const opus = answering("opus", halfSecond, 0.5);
    await expect(speakInParts(opus.provider, input("opus"), one)).rejects.toThrow(
      "an Opus clip cannot be added to",
    );
    expect(opus.texts).toEqual([]);
    expect(texts).toHaveLength(1);
  });
});

test("a new length for the book's pauses stales the clips of the lines holding one", async () => {
  const api = testApi();
  const id = await voicedBook(api, {
    endpoints: [speechEndpoint()],
    paragraphs: ["“We are short again,” said Mara.", ...story(3)],
    voiceOf: "studio/ash",
  });
  await narrateChapters(api, id, [1]);
  const segs = readScript(api.db, id, 1);
  expect(segs.every((s) => s.audio.status === "done")).toBe(true);
  // a short pause of the book's length, a short one of its own, and a long one
  segs[0].expressions = [pauseAnnotation("pause", 0, 1)];
  segs[1].expressions = [pauseAnnotation("pause", 0, 1, 0.8)];
  segs[2].expressions = [pauseAnnotation("long pause", 0, 1)];
  writeScript(api.db, id, 1, segs);

  const patch = (pacing: object) =>
    api.request<{ stale: { chapterId: number; ids: number[]; revision: number }[] }>(
      `/api/books/${id}`,
      { ...jsonBody({ pacing }), method: "PATCH" },
    );
  // the gaps between lines move nothing
  expect((await patch({ ...DEFAULT_PACING, line: 1 })).body.stale).toEqual([]);
  const { body: moved } = await patch({ ...DEFAULT_PACING, line: 1, inlineShort: 0.6 });
  expect(moved.stale).toEqual([{ chapterId: 1, ids: [segs[0].id], revision: expect.any(Number) }]);
  const after = readScript(api.db, id, 1);
  expect(after.map((s) => s.audio.status).slice(0, 4)).toEqual(["stale", "done", "done", "done"]);

  // narrated again, the line is its clip with the new pause's silence before it: the test
  // endpoint's model has no pause tag
  await narrateChapters(api, id, [1]);
  const again = readScript(api.db, id, 1)[0];
  expect(again.audio.status).toBe("done");
  expect(again.audio.duration).toBeCloseTo(segs[0].audio.duration + 0.6, 2);
});
