// The effects editor's moves on a chain — keys that stay with a step through a move and a reactive
// proxy, copies with keys of their own, deletes that can be put back — and the names it gives: a
// copy's, a pasted board's, and the places an effect is used.
import { describe, expect, test } from "bun:test";
import { reactive } from "vue";

import type { EffectUses, MixStep, Step } from "@/types";
import {
  duplicateAt,
  keyOf,
  listed,
  locate,
  nameFromCode,
  placesOf,
  removeAt,
  shift,
  uniqueName,
} from "@/views/cast/effects/chain";

const gain = (db: number): Step => ({ plugin: "Gain", params: { gain_db: db }, on: true });
const chain = (): Step[] => [
  gain(1),
  {
    on: true,
    mix: [
      { name: "A", on: true, steps: [gain(2)] },
      { name: "B", on: true, steps: [] },
    ],
  },
  gain(3),
];

describe("keys", () => {
  test("a step keeps its key through a reactive proxy and a move", () => {
    const raw = chain();
    const c = reactive(raw);
    const k = keyOf(raw[2]!);
    expect(keyOf(c[2]!)).toBe(k);
    shift(locate(c, k)!, -1);
    expect(keyOf(c[1]!)).toBe(k);
  });
  test("locate finds a layer, and a step inside one with its layer", () => {
    const c = chain();
    const mix = c[1] as MixStep;
    const layer = locate(c, keyOf(mix.mix[1]!));
    expect(layer?.kind).toBe("layer");
    const inner = locate(c, keyOf(mix.mix[0]!.steps[0]!));
    expect(inner?.kind === "step" && inner.layer?.name).toBe("A");
    expect(locate(c, "nope")).toBeNull();
  });
});

describe("moves", () => {
  test("shift stops at either end", () => {
    const c = chain();
    expect(shift(locate(c, keyOf(c[0]!))!, -1)).toBe(false);
    expect(shift(locate(c, keyOf(c[2]!))!, 1)).toBe(false);
  });
  test("a duplicate is a deep copy right after it, with a key of its own", () => {
    const c = chain();
    const k = duplicateAt(locate(c, keyOf(c[1]!))!);
    expect(c).toHaveLength(4);
    expect(keyOf(c[2]!)).toBe(k);
    expect(k).not.toBe(keyOf(c[1]!));
    expect(c[2]).toEqual(c[1]!);
    (c[2] as MixStep).mix[0]!.steps.length = 0;
    expect((c[1] as MixStep).mix[0]!.steps).toHaveLength(1);
  });
  test("a duplicated layer is named as a copy", () => {
    const c = chain();
    duplicateAt(locate(c, keyOf((c[1] as MixStep).mix[0]!))!);
    expect((c[1] as MixStep).mix.map((l) => l.name)).toEqual(["A", "A copy", "B"]);
  });
  test("a removed step can be put back where it was", () => {
    const c = chain();
    const r = removeAt(locate(c, keyOf(c[0]!))!);
    expect(c).toHaveLength(2);
    r.list.splice(r.index, 0, r.item);
    expect(c).toEqual(chain());
  });
});

describe("names", () => {
  test("a taken name gets a number", () => {
    expect(uniqueName("New effect", new Set())).toBe("New effect");
    expect(uniqueName("New effect", new Set(["New effect", "New effect (2)"]))).toBe(
      "New effect (3)",
    );
  });
  test("a pasted board is named after the last name the code gives", () => {
    const code = "layers = Mix([])\nweaver_mask_board = Pedalboard([layers])";
    expect(nameFromCode(code)).toBe("Weaver mask board");
    expect(nameFromCode("Pedalboard([Gain(1)])")).toBe("Pasted effect");
  });
  test("places name speakers, thoughts and books, and leave out the choice being edited", () => {
    const uses: EffectUses = {
      library: true,
      books: [
        { id: "b1", title: "Here" },
        { id: "b2", title: "Elsewhere" },
      ],
      speakers: [
        { bookId: "b1", bookTitle: "Here", name: "Ann", effect: true, thoughts: true },
        { bookId: "b2", bookTitle: "Elsewhere", name: "Bo", effect: true, thoughts: false },
      ],
    };
    expect(placesOf(uses, "b1")).toEqual([
      "Ann",
      "Ann’s thoughts",
      "Bo in Elsewhere",
      "this book’s thoughts",
      "thoughts in Elsewhere",
      "all books’ thoughts",
    ]);
    expect(placesOf(uses, "b1", { bookId: "b1", view: "effect", name: "Ann" })).not.toContain(
      "Ann",
    );
    expect(placesOf(uses, "b1", { bookId: "b1", view: "book", name: "" })).not.toContain(
      "this book’s thoughts",
    );
  });
  test("a long list is cut short", () => {
    expect(listed(["a", "b"])).toBe("a, b");
    expect(listed(["a", "b", "c", "d", "e", "f"], 4)).toBe("a, b, c, d and 2 more");
  });
});
