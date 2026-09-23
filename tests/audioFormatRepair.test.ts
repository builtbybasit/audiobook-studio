// Keeping a speech endpoint's format, bitrate and rate a combination its API can be asked for.
//
// The picker narrows its lists to what the chosen format offers, but two moves change the lists
// under a choice already made: switching format, and saving a base URL that speaks another API.
// Each has to keep what still fits, put back what does not, and say so — a combination left
// invalid is one the server refuses the next line with.
import { describe, expect, test } from "bun:test";

import {
  encodingChanged,
  encodingSummary,
  repairEncoding,
  sizeLabel,
  sizePerMinute,
  type EncodingFields,
} from "@/lib/audioFormat";
import { encodingProblems } from "@/lib/endpointShapes";
import { unifyEndpoint } from "@/lib/endpoints";
import { applyDraft, draftFor } from "@/views/endpoints/state";
import type { Endpoint } from "@/types";

const FISH = "https://api.fish.audio/v1";
const OPENAI = "https://api.openai.com/v1";
const at = (baseUrl: string, over: Partial<EncodingFields> = {}): EncodingFields => ({
  baseUrl,
  ...over,
});

describe("switching format", () => {
  test("keeps a rate the new format also offers, and drops a bitrate it has no use for", () => {
    const r = repairEncoding(
      at(FISH, { encoding: { format: "mp3", bitrate: 192 }, sampleRate: 32000 }),
      "wav",
    );
    expect(r).toEqual({
      encoding: null,
      sampleRate: 32000,
      notes: [expect.stringContaining("takes no bitrate")],
    });
    expect(repairEncoding(at(FISH, { sampleRate: 44100 }), "mp3")).toEqual({
      encoding: { format: "mp3" },
      sampleRate: 44100,
      notes: [],
    });
  });

  test("puts a rate or bitrate the new format lacks back to the provider's default, and says so", () => {
    const r = repairEncoding(
      at(FISH, { encoding: { format: "mp3", bitrate: 128 }, sampleRate: 44100 }),
      "opus",
    );
    expect(r.encoding).toEqual({ format: "opus" });
    expect(r.sampleRate).toBeNull();
    expect(r.notes).toEqual([
      "Opus here has no 128 kbps; the bitrate is the provider's default (Automatic).",
      "Opus here has no 44.1 kHz; the rate is the provider's default (48 kHz).",
    ]);
    // whatever it answered is a combination with nothing wrong with it
    expect(encodingProblems({ baseUrl: FISH, ...r })).toEqual([]);
  });
});

describe("a base URL that speaks another API", () => {
  test("Fish to OpenAI keeps the format but clears what OpenAI cannot be asked for", () => {
    const r = repairEncoding(
      at(OPENAI, { encoding: { format: "opus", bitrate: 32000 }, sampleRate: 48000 }),
    );
    expect(r.encoding).toEqual({ format: "opus" });
    expect(r.sampleRate).toBeNull();
    expect(r.notes).toHaveLength(2);
  });

  test("a choice that already fits is left alone and changes nothing", () => {
    const e = at(FISH, { encoding: { format: "mp3", bitrate: 64 }, sampleRate: 32000 });
    const r = repairEncoding(e);
    expect(r.notes).toEqual([]);
    expect(encodingChanged(e, r)).toBe(false);
    // WAV spelt out and WAV left unsaid are the same choice
    expect(
      encodingChanged(at(FISH, { encoding: { format: "wav" } }), repairEncoding(at(FISH))),
    ).toBe(false);
  });

  test("saving the draft repairs the endpoint in the same write and returns what it put back", () => {
    const ep = {
      id: "fish",
      name: "Fish",
      baseUrl: FISH,
      model: "s2.1-pro",
      concurrency: 1,
      enabled: true,
      latency: 0,
      failRate: 0,
      price: 0,
      needsKey: false,
      maxChars: 0,
      splitAt: "sentence",
      voices: [],
      history: [],
      failures: 0,
      rateLimits: 0,
      backoffUntil: 0,
      encoding: { format: "mp3", bitrate: 192 },
      sampleRate: 32000,
    } as Endpoint;
    const u = unifyEndpoint(ep);
    draftFor(u).baseUrl = OPENAI;
    const notes = applyDraft(u);
    expect(ep.baseUrl).toBe(OPENAI);
    expect(ep.encoding).toEqual({ format: "mp3" });
    expect(ep.sampleRate).toBeNull();
    expect(notes).toHaveLength(2);
  });
});

describe("size per minute", () => {
  test("WAV is the rate times two bytes; a compressed format is its bitrate over eight", () => {
    expect(sizePerMinute(at(FISH))).toMatchObject({ bytes: 44100 * 2 * 60, approx: false });
    expect(sizePerMinute(at(FISH, { sampleRate: 16000 }))!.bytes).toBe(1_920_000);
    expect(sizePerMinute(at(FISH, { encoding: { format: "mp3" } }))!.bytes).toBe(960_000);
    expect(sizePerMinute(at(FISH, { encoding: { format: "opus", bitrate: 64000 } }))!.bytes).toBe(
      480_000,
    );
    // Opus's automatic bitrate is an assumption, and is marked as one
    expect(sizePerMinute(at(FISH, { encoding: { format: "opus" } }))).toMatchObject({
      bytes: 240_000,
      approx: true,
    });
  });

  test("is unknown where the API does not say what it answers at", () => {
    expect(sizePerMinute(at(OPENAI))).toBeNull();
    expect(sizePerMinute(at(OPENAI, { encoding: { format: "mp3" } }))).toBeNull();
  });

  test("reads as a file manager would show it", () => {
    expect(sizeLabel(5_292_000)).toBe("5.3 MB");
    expect(sizeLabel(960_000)).toBe("960 KB");
  });
});

test("the request summary names format, bitrate and rate, defaults filled in", () => {
  expect(encodingSummary(at(FISH, { encoding: { format: "mp3" } }))).toBe(
    "MP3 · 128 kbps · 44.1 kHz",
  );
  expect(encodingSummary(at(FISH, { encoding: { format: "opus", bitrate: 24000 } }))).toBe(
    "Opus · 24 kbps · 48 kHz",
  );
  expect(encodingSummary(at(OPENAI))).toBe("WAV · model's rate");
});
