// What a voice row and the clone check say of a likeness report: band words, the other endpoint
// named, unknown voices by id, a twin said once as a warning.
import { describe, expect, test } from "bun:test";

import type { Endpoint, VoiceLikeness } from "@/types";
import {
  doubleOf,
  soundsLike,
  tipOf,
  voiceFinder,
  type FindVoice,
} from "@/views/endpoints/soundsLike";

const NAMES: Record<string, string> = { "fish/mara": "Mara", "omni/mara": "Mara", "omni/bo": "Bo" };
const find: FindVoice = (e, v) => ({
  label: NAMES[`${e}/${v}`] ?? v,
  endpoint: e === "fish" ? "Fish Audio" : "OmniVoice",
});
const voice = (over: Partial<VoiceLikeness> = {}): VoiceLikeness => ({
  endpointId: "omni",
  voiceId: "new",
  nearest: [],
  twins: [],
  mixed: false,
  ...over,
});

describe("a voice row", () => {
  test("names the band, and the endpoint only when it is another", () => {
    const row = soundsLike(
      voice({
        nearest: [
          { endpointId: "omni", voiceId: "bo", score: 0.81 },
          { endpointId: "fish", voiceId: "mara", score: 0.6 },
          { endpointId: "omni", voiceId: "gone", score: 0.58 },
        ],
      }),
      find,
    );
    expect(row?.chips.map((c) => [c.text, c.tip, c.same])).toEqual([
      ["Bo · same voice", "0.81", true],
      ["Mara on Fish Audio · very alike", "0.60 · on Fish Audio", false],
      ["gone · very alike", "0.58", false],
    ]);
  });

  test("says a twin and mixed samples as warnings, not as chips", () => {
    const twin = { endpointId: "omni", voiceId: "bo", score: 0.99 };
    const row = soundsLike(voice({ nearest: [twin], twins: [twin], mixed: true }), find);
    expect(row).toEqual({
      chips: [],
      warnings: ["Same recording as Bo", "Its samples sound like different voices"],
    });
  });

  test("shows nothing below the alike band", () => {
    expect(
      soundsLike(voice({ nearest: [{ endpointId: "omni", voiceId: "bo", score: 0.3 }] }), find),
    ).toBeNull();
  });
});

describe("the row icon's tip", () => {
  test("puts warnings first and names each match once, with its score", () => {
    const twin = { endpointId: "omni", voiceId: "bo", score: 0.99 };
    const row = soundsLike(
      voice({
        nearest: [twin, { endpointId: "fish", voiceId: "mara", score: 0.6 }],
        twins: [twin],
      }),
      find,
    )!;
    expect(tipOf(row)).toBe("Same recording as Bo; Mara on Fish Audio · very alike 0.60");
  });
});

describe("voiceFinder", () => {
  test("names saved voices and falls back to ids", () => {
    const find = voiceFinder([
      { id: "omni", name: "OmniVoice", voices: [{ id: "bo", label: "Bo", gender: "m" }] },
    ] as Endpoint[]);
    expect([find("omni", "bo"), find("omni", "gone"), find("lost", "x")]).toEqual([
      { label: "Bo", endpoint: "OmniVoice" },
      { label: "gone", endpoint: "OmniVoice" },
      { label: "x", endpoint: "lost" },
    ]);
  });
});

describe("the clone check", () => {
  test.each([
    [
      "a twin",
      voice({ twins: [{ endpointId: "fish", voiceId: "mara", score: 1 }] }),
      "new keeps the same recording as Mara on Fish Audio",
    ],
    [
      "a same-voice match",
      voice({ nearest: [{ endpointId: "omni", voiceId: "bo", score: 0.75 }] }),
      "new sounds like Bo — same voice",
    ],
    ["only alike", voice({ nearest: [{ endpointId: "omni", voiceId: "bo", score: 0.6 }] }), null],
  ])("%s", (_, l, said) => {
    expect(doubleOf([l], "omni", "new", find)).toBe(said);
  });

  test("says nothing of a voice the report leaves out", () => {
    expect(doubleOf([voice()], "omni", "other", find)).toBeNull();
  });
});
