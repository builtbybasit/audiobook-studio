import { describe, expect, test } from "bun:test";
import { newSpeaker } from "@/lib/cast";
import { fitPlan, type LibraryVoice, scoreVoice, suggestVoices, voiceGaps } from "@/lib/voiceMatch";
import { voiceBands } from "@/lib/voiceProfile";
import type { Character, Voice } from "@/types";

// fewer than nine measured voices: the typical bands, male f0 thirds at 111 and 122 Hz
const bands = voiceBands([]);
const who = (name: string, over: Partial<Character> = {}): Character => ({
  ...newSpeaker(name, 0),
  isNew: false,
  gender: "m",
  ...over,
});
const voice = (id: string, over: Partial<Voice> = {}): LibraryVoice => ({
  ref: `ep/${id}`,
  voice: { id, label: id, gender: "m", ...over },
});
const low = { f0: 100, hnr: 8, rangeSt: 12, voicedSec: 60 };

describe("scoreVoice", () => {
  test.each([
    ["genders that differ rule it out", {}, { gender: "f" }, null],
    ["an unknown gender takes any voice", { gender: "?" }, { gender: "f" }, [0, []]],
    ["the same age", { age: "elderly" }, { profile: { age: "elderly" } }, [3, ["same age"]]],
    [
      "a neighbouring age",
      { age: "elderly" },
      { profile: { age: "middle-aged" } },
      [1, ["near age"]],
    ],
    ["a far age adds nothing", { age: "child" }, { profile: { age: "elderly" } }, [0, []]],
    [
      "a measured pitch",
      { voiceType: { pitch: "low" } },
      { profile: { measured: low } },
      [2, ["low"]],
    ],
    [
      "each shared delivery word",
      { voiceType: { delivery: ["cold", "stern", "sly"] } },
      { profile: { delivery: ["cold", "sly", "warm"] } },
      [2, ["cold", "sly"]],
    ],
    [
      "an avoid phrase about their age group",
      { age: "child" },
      { profile: { age: "teen", avoid: ["small kids"] } },
      [-2, ["near age"]],
    ],
  ] as [string, Partial<Character>, Partial<Voice>, [number, string[]] | null][])(
    "%s",
    (_, c, v, want) => {
      const got = scoreVoice(who("A", c), voice("v", v).voice, bands);
      expect(got && [got.score, got.reasons]).toEqual(want);
    },
  );
});

test("suggestions are the three best fits, a voice no one else uses ahead of an equal one", () => {
  const old = { profile: { age: "elderly" as const } };
  const voices = ["a", "b", "c", "d", "e"].map((id) => voice(id, old));
  voices.push(voice("unfit", { profile: { age: "child" } }));
  const got = suggestVoices(who("Abbot", { age: "elderly" }), voices, bands, {
    "ep/a": ["Someone"],
    "ep/b": ["Abbot"],
  });
  expect(got).toHaveLength(3);
  expect(got.map((s) => s.voice)).not.toContain("ep/a");
  expect(got.map((s) => s.voice)).not.toContain("ep/unfit");
});

describe("fitPlan", () => {
  const old = voice("old", { profile: { age: "elderly" } });
  const other = voice("other", { profile: { age: "teen" } });
  const third = voice("third");

  test("main speakers get distinct voices, minor ones reuse the best fit", () => {
    const cast = [
      who("Narrator"),
      who("Elder", { age: "elderly", major: true }),
      who("Sage", { age: "elderly", major: true }),
      who("Monk", { age: "elderly" }),
      who("Friar", { age: "elderly" }),
    ];
    const plan = fitPlan(cast, [old, other, third], bands, { Sage: { lines: 90 } });
    const of = (n: string) => plan.find((r) => r.name === n)?.voice;
    expect(plan.map((r) => r.name)).not.toContain("Narrator");
    // the main speaker with more lines gets the better fit
    expect(of("Sage")).toBe("ep/old");
    expect(of("Elder")).not.toBe("ep/old");
    expect(of("Monk")).toBe("ep/old");
    expect(of("Friar")).toBe("ep/old");
  });

  test("a main voice already given stays theirs; the voiced and linked personas are skipped", () => {
    const cast = [
      who("Elder", { age: "elderly", major: true, voice: "ep/old" }),
      who("Sage", { age: "elderly", major: true }),
      who("Mask", { personaOf: "Elder" }),
    ];
    const plan = fitPlan(cast, [old, other], bands, {});
    expect(plan).toEqual([expect.objectContaining({ name: "Sage", voice: "ep/other" })]);
  });

  test("a speaker whose gender has no voice takes any", () => {
    const plan = fitPlan([who("Ana", { gender: "f" })], [old], bands, {});
    expect(plan.map((r) => r.voice)).toEqual(["ep/old"]);
  });
});

test("voice gaps group speakers by gender and age against voices of that age, most first", () => {
  const cast = [
    who("Narrator", { age: "elderly" }),
    ...["a", "b", "c"].map((n) => who(n, { age: "elderly" })),
    ...["d", "e"].map((n) => who(n, { gender: "f", age: "teen" })),
    who("covered", { gender: "f", age: "child" }),
    who("ageless"),
    who("genderless", { gender: "?", age: "child" }),
  ];
  const voices = [
    voice("girl", { gender: "f", profile: { age: "child" } }),
    voice("unaged", { gender: "m" }),
  ];
  expect(voiceGaps(cast, voices, {})).toEqual([
    { gender: "m", age: "elderly", label: "elderly men", speakers: 3, voices: 0 },
    { gender: "f", age: "teen", label: "teen girls", speakers: 2, voices: 0 },
  ]);
});
