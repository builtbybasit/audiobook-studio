// The moves the effects editor makes on a chain, in place, and the names it gives.
// Stored steps have no ids (Pedalboard's shape), so each step and layer gets a key in a WeakMap;
// keys never reach the server. They hang off the raw object, so a reactive proxy shares its key.
import { toRaw } from "vue";

import type { EffectUses, Layer, MixStep, Step } from "@/types";
import { isMix } from "./catalog";
import type { ChoiceView } from "./choice";

const keys = new WeakMap<object, string>();
let next = 0;

/** A step's or a layer's key: the same for as long as the object lives, never sent anywhere. */
export function keyOf(x: Step | Layer): string {
  const raw = toRaw(x);
  let k = keys.get(raw);
  if (!k) keys.set(raw, (k = `k${++next}`));
  return k;
}

/** Where a key sits: a step in a list (and the layer it is inside, if any), or a Mix's layer. */
export type Found =
  | { kind: "step"; step: Step; list: Step[]; index: number; layer: Layer | null }
  | { kind: "layer"; layer: Layer; mix: MixStep; index: number };

/** The step or layer with this key anywhere in the chain, with the list it sits in. */
export function locate(
  chain: Step[],
  key: string | null,
  inLayer: Layer | null = null,
): Found | null {
  if (!key) return null;
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i]!;
    if (keyOf(s) === key) return { kind: "step", step: s, list: chain, index: i, layer: inLayer };
    if (!isMix(s)) continue;
    for (let j = 0; j < s.mix.length; j++) {
      const l = s.mix[j]!;
      if (keyOf(l) === key) return { kind: "layer", layer: l, mix: s, index: j };
      const deep = locate(l.steps, key, l);
      if (deep) return deep;
    }
  }
  return null;
}

const listOf = (f: Found): (Step | Layer)[] => (f.kind === "step" ? f.list : f.mix.mix);

/** Move it within its own list by `by`; false at either end. */
export function shift(f: Found, by: number): boolean {
  const list = listOf(f);
  const to = f.index + by;
  if (to < 0 || to >= list.length) return false;
  const [x] = list.splice(f.index, 1);
  list.splice(to, 0, x!);
  return true;
}

/** A deep copy in right after it — new objects, so new keys; the copy's key. */
export function duplicateAt(f: Found): string {
  const list = listOf(f);
  const copy = structuredClone(toRaw(f.kind === "step" ? f.step : f.layer)) as Step | Layer;
  if (f.kind === "layer") (copy as Layer).name = `${f.layer.name} copy`;
  list.splice(f.index + 1, 0, copy);
  return keyOf(copy);
}

/** Take it out; what was taken, and where, so an undo can put it back. */
export function removeAt(f: Found): { list: (Step | Layer)[]; index: number; item: Step | Layer } {
  const list = listOf(f);
  const [item] = list.splice(f.index, 1);
  return { list, index: f.index, item: item! };
}

/** `base`, or "base (2)", "(3)"… while the name is taken. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base} (${n})`;
  return out;
}

/**
 * A pasted chain's name, from the last name the code gives anything — which is the board it builds:
 * "weaver_mask_board = Pedalboard(" reads "Weaver mask board".
 */
export function nameFromCode(code: string): string {
  const v = [...code.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]!).at(-1);
  if (!v) return "Pasted effect";
  const words = v.replace(/_+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Pasted effect";
}

/** Whose choice an editor is open for, so "Also on" can leave that one out. */
export interface UsesSelf {
  bookId: string;
  view: ChoiceView;
  name: string;
}

/**
 * Everywhere an effect is chosen, in words: "Ann", "Ann’s thoughts in Other Book", "all books’
 * thoughts". `self` is left out. No chapter is named (no spoilers).
 */
export function placesOf(uses: EffectUses, here: string, self: UsesSelf | null = null): string[] {
  const out: string[] = [];
  const mine = (bookId: string, view: UsesSelf["view"], name = "") =>
    !!self && self.bookId === bookId && self.view === view && self.name === name;
  for (const s of uses.speakers) {
    const where = s.bookId === here ? "" : ` in ${s.bookTitle}`;
    if (s.effect && !mine(s.bookId, "effect", s.name)) out.push(`${s.name}${where}`);
    if (s.thoughts && !mine(s.bookId, "thoughts", s.name)) out.push(`${s.name}’s thoughts${where}`);
  }
  for (const b of uses.books)
    if (!mine(b.id, "book"))
      out.push(b.id === here ? "this book’s thoughts" : `thoughts in ${b.title}`);
  if (uses.library) out.push("all books’ thoughts");
  return out;
}

/** A list cut short for one line: "A, B, C and 4 more". */
export function listed(items: string[], max = 4): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}
