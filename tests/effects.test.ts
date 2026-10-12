// Which effects a line gets — the speaker's own, then the thought effect chosen speaker → book →
// library — and the fingerprint that tells a clip with the old sound from one with the current.
import { describe, expect, test } from "bun:test";

import { chainsFor, soundOf, type EffectContext } from "@/lib/effects";
import type { Effect } from "@/types";

const fx = (id: string, gain = -1): Effect => ({
  id,
  name: id,
  chain: [{ plugin: "Gain", params: { gain_db: gain }, on: true }],
});
const ctx = (over: Partial<EffectContext> = {}): EffectContext => ({
  effects: new Map(["inner", "mask", "echo"].map((id) => [id, fx(id)])),
  library: "inner",
  book: null,
  cast: new Map(),
  ...over,
});
const ids = (line: { type: "thought" | "dialogue"; speaker: string }, c: EffectContext) =>
  chainsFor(line, c).map((e) => e.id);

describe("chainsFor", () => {
  test("a thought follows the library when the book and speaker follow", () => {
    expect(ids({ type: "thought", speaker: "Ann" }, ctx())).toEqual(["inner"]);
  });
  test("the book's own beats the library, the speaker's beats both", () => {
    expect(ids({ type: "thought", speaker: "Ann" }, ctx({ book: "echo" }))).toEqual(["echo"]);
    const cast = new Map([["Ann", { thoughts: "mask" }]]);
    expect(ids({ type: "thought", speaker: "Ann" }, ctx({ book: "echo", cast }))).toEqual(["mask"]);
  });
  test("none at any level stops the chain there", () => {
    expect(ids({ type: "thought", speaker: "Ann" }, ctx({ book: "none" }))).toEqual([]);
    const cast = new Map([["Ann", { thoughts: "none" }]]);
    expect(ids({ type: "thought", speaker: "Ann" }, ctx({ book: "echo", cast }))).toEqual([]);
  });
  test("the speaker's own effect runs first, and only thoughts get the thought effect", () => {
    const cast = new Map([["Ann", { effect: "mask" }]]);
    expect(ids({ type: "thought", speaker: "Ann" }, ctx({ cast }))).toEqual(["mask", "inner"]);
    expect(ids({ type: "dialogue", speaker: "Ann" }, ctx({ cast }))).toEqual(["mask"]);
  });
  test("an effect that is gone is nothing", () => {
    const cast = new Map([["Ann", { effect: "gone" }]]);
    expect(ids({ type: "thought", speaker: "Ann" }, ctx({ cast, library: "gone" }))).toEqual([]);
  });
});

describe("soundOf", () => {
  test("nothing on is no sound", () => {
    expect(soundOf([])).toBeNull();
    expect(
      soundOf([{ ...fx("a"), chain: [{ plugin: "Gain", params: {}, on: false }] }]),
    ).toBeNull();
  });
  test("names, ids, off steps and key order don't change it; a value does", () => {
    const a = fx("a");
    const b: Effect = {
      id: "b",
      name: "other",
      chain: [
        { plugin: "Reverb", params: {}, on: false },
        { on: true, params: { gain_db: -1 }, plugin: "Gain" },
      ],
    };
    expect(soundOf([a])).toBe(soundOf([b]));
    expect(soundOf([a])).not.toBe(soundOf([fx("a", -2)]));
    expect(soundOf([a, a])).not.toBe(soundOf([a]));
  });
});
