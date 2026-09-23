// What a speech endpoint can be asked for, and why a combination cannot.
//
// The table is Fish Audio's and OpenAI's documentation turned into data, and `encodingProblems` is
// the one judgement the page shows beside the fields and the server refuses a line with — so a
// request the provider would refuse, or quietly answer at another rate, never goes out.
import { describe, expect, test } from "bun:test";

import type { Endpoint } from "@/types";
import { encodingOf, encodingProblems, speechFormats } from "@/lib/endpointShapes";

type Asked = Pick<Endpoint, "baseUrl" | "encoding" | "sampleRate">;
const fish = (over: Partial<Asked> = {}): Asked => ({
  baseUrl: "https://api.fish.audio/v1",
  ...over,
});
const openai = (over: Partial<Asked> = {}): Asked => ({
  baseUrl: "https://api.openai.com/v1",
  ...over,
});

describe("the formats an endpoint offers", () => {
  test("Fish offers WAV, MP3 and Opus with their own rates and bitrates; OpenAI no rate at all", () => {
    const f = speechFormats(fish());
    expect(f.map((x) => [x.format, x.rates, x.bitrates.map((b) => b.value)])).toEqual([
      ["wav", [16000, 24000, 32000, 44100], []],
      ["mp3", [32000, 44100], [64, 128, 192]],
      ["opus", [48000], [-1000]],
    ]);
    expect(speechFormats(openai()).map((x) => [x.format, x.rates])).toEqual([
      ["wav", null],
      ["mp3", null],
      ["opus", null],
    ]);
  });

  test("an endpoint that chose nothing asks for WAV", () => {
    expect(encodingOf({})).toEqual({ format: "wav" });
    expect(encodingOf({ encoding: null })).toEqual({ format: "wav" });
  });
});

describe("a combination that cannot be asked for", () => {
  test("is fine when every part is on the list, or left to the provider", () => {
    expect(
      encodingProblems(fish({ encoding: { format: "mp3", bitrate: 192 }, sampleRate: 32000 })),
    ).toEqual([]);
    expect(encodingProblems(fish({ encoding: { format: "opus" } }))).toEqual([]);
    expect(encodingProblems(openai({ encoding: { format: "mp3" } }))).toEqual([]);
  });

  test("names a bitrate or a rate the format does not have", () => {
    expect(encodingProblems(fish({ encoding: { format: "mp3", bitrate: 320 } }))).toEqual([
      "MP3 here is 64 kbps, 128 kbps, 192 kbps",
    ]);
    expect(encodingProblems(fish({ encoding: { format: "opus" }, sampleRate: 44100 }))).toEqual([
      "Opus here is 48 kHz",
    ]);
    expect(encodingProblems(fish({ encoding: { format: "wav", bitrate: 128 } }))).toEqual([
      "WAV takes no bitrate here",
    ]);
  });

  test("an API that takes no rate refuses any rate, whatever the format", () => {
    expect(encodingProblems(openai({ sampleRate: 24000 }))).toEqual([
      "This API answers at the model's own sample rate and cannot be asked for one; clear it",
    ]);
  });
});
