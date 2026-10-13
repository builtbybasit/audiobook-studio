// The Cast table's persona rows (`nestPersonas`): a linked persona sits right under its character
// whatever the sort, and stands on its own when a search finds only the persona or the scripting
// model made the link.
import { expect, test } from "bun:test";

import { nestPersonas } from "@/views/cast/persona/rows";

const cast = [
  { name: "Narrator" },
  { name: "Sunny" },
  { name: "Lord of Shadows", personaOf: "Sunny" },
  { name: "Weaver", personaOf: "Sunny" },
  { name: "Nephis" },
  { name: "Stranger", personaOf: "Nobody" },
  { name: "Veil", personaOf: "Nephis", masked: true },
];
const byName = new Map(cast.map((c) => [c.name, c]));
const rows = (...names: string[]) => names.map((n) => ({ c: byName.get(n)! }));
const order = (r: { c: { name: string }; nested: boolean }[]) =>
  r.map((x) => (x.nested ? "↳" : "") + x.c.name);

test("a persona follows its character, in the order the personas came", () => {
  expect(
    order(nestPersonas(rows("Weaver", "Nephis", "Narrator", "Lord of Shadows", "Sunny"), byName)),
  ).toEqual(["Nephis", "Narrator", "Sunny", "↳Weaver", "↳Lord of Shadows"]);
});

test("a persona whose character is filtered out keeps its own place", () => {
  expect(order(nestPersonas(rows("Nephis", "Weaver"), byName))).toEqual(["Nephis", "Weaver"]);
});

test("a link to nobody in the cast is no link", () => {
  expect(order(nestPersonas(rows("Stranger", "Sunny"), byName))).toEqual(["Stranger", "Sunny"]);
});

test("a chained link nests one level only, and drops no row", () => {
  const chain = new Map([
    ["A", { name: "A", personaOf: "B" }],
    ["B", { name: "B", personaOf: "C" }],
    ["C", { name: "C" }],
  ]);
  const r = ["A", "B", "C"].map((n) => ({ c: chain.get(n)! }));
  expect(order(nestPersonas(r, chain))).toEqual(["A", "C", "↳B"]);
});

test("a link the scripting model made keeps its own place: nesting it would spoil who wears it", () => {
  expect(order(nestPersonas(rows("Veil", "Nephis"), byName))).toEqual(["Veil", "Nephis"]);
});
