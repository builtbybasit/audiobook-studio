// A script file's chapter whose source words this book lacks pairs with the book chapter its lines
// read closest to, under the bar `fidelity` sets for a model's script; the lines then move onto
// the book's words. A sampled shingle index keeps 900 × 900 chapters to a handful of real diffs.
import { diffArrays } from "diff";

import type { Segment } from "@/types";
import { tokensOf, wordsOf } from "@/lib/gaps";
import { allowedEdits, wordFidelity, type Fidelity } from "~/providers/chatScripting";

export interface TextChapter {
  /** place in reading order, to break a tie between near-identical chapters */
  position: number;
  words: string[];
}

/** `book` indexes the book chapters passed in; `closest` is the nearest that failed, if any. */
export type TextPair = { book: number; check: Fidelity } | { book?: undefined; closest?: Fidelity };

/** One 3-word shingle in SAMPLE (a power of two) goes in the index, the same ones on both sides. */
const SAMPLE = 8;
/** A chapter with fewer sampled shingles is short: it is diffed against every same-length one. */
const SHORT = 8;
/** Diffs to try on a long chapter before calling it unmatched. */
const TRIES = 3;

/** Words are interned to numbers first: hashing strings was most of the cost. */
function shingles(words: readonly string[], ids: Map<string, number>): Set<number> {
  const out = new Set<number>();
  let a = 0;
  let b = 0;
  for (let i = 0; i < words.length; i++) {
    let c = ids.get(words[i]);
    if (c === undefined) ids.set(words[i], (c = ids.size + 1));
    if (i >= 2) {
      let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d);
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
      h ^= h >>> 12;
      if ((h & (SAMPLE - 1)) === 0) out.add(h);
    }
    a = b;
    b = c;
  }
  return out;
}

/** `fidelity` can only pass when the counts differ by no more than it allows either way. */
const inBand = (file: TextChapter, book: TextChapter): boolean =>
  Math.abs(file.words.length - book.words.length) <= allowedEdits(book.words.length);

const differ = (f: Fidelity): number => f.missing + f.added;

/** Each file chapter in order takes the best book chapter still free that passes `fidelity`. */
export function pairByText(
  files: readonly TextChapter[],
  book: readonly TextChapter[],
): TextPair[] {
  const ids = new Map<string, number>();
  const index = new Map<number, number[]>();
  book.forEach((b, i) => {
    for (const h of shingles(b.words, ids)) (index.get(h) ?? index.set(h, []).get(h)!).push(i);
  });
  const taken = new Set<number>();

  return files.map((file): TextPair => {
    const sample = shingles(file.words, ids);
    const short = sample.size < SHORT;
    const score = new Map<number, number>();
    for (const h of sample)
      for (const i of index.get(h) ?? []) if (!taken.has(i)) score.set(i, (score.get(i) ?? 0) + 1);
    if (short)
      book.forEach((b, i) => {
        if (!taken.has(i) && inBand(file, b)) score.set(i, score.get(i) ?? 0);
      });
    const far = (i: number): number => Math.abs(book[i].position - file.position);
    const ranked = [...score].sort(([i, x], [j, y]) => y - x || far(i) - far(j)).map(([i]) => i);
    // a true pair shares ~90% of its shingles; half is a safe floor that skips hopeless diffs
    const plausible = ranked.filter(
      (i) => inBand(file, book[i]) && (short || score.get(i)! * 2 >= sample.size),
    );

    let closest: Fidelity | undefined;
    for (const i of short ? plausible : plausible.slice(0, TRIES)) {
      const check = wordFidelity(book[i].words, file.words);
      if (check.ok) {
        taken.add(i);
        return { book: i, check };
      }
      if (!closest || differ(check) < differ(closest)) closest = check;
    }
    if (!closest && ranked.length) closest = wordFidelity(book[ranked[0]].words, file.words);
    return { closest };
  });
}

/** How far the nearest chapter was, for a refusal's detail. */
export const closestDetail = (closest: Fidelity | undefined): string =>
  closest ? `; the closest chapter differs by ${differ(closest)} words` : "";

// ---------- moving the lines onto the book's words ----------

interface Token {
  /** the line it is in */
  seg: number;
  /** offsets in the line's text, or the book's */
  start: number;
  /** end of the token's own characters, before the space after it */
  end: number;
  /** end of the space after it */
  next: number;
  /** index of its first word in the side's words */
  first: number;
  count: number;
}

/** Characters per piece: a change cuts only its own pieces into tokens. */
const PIECE = 120;

/**
 * One side's words, read a piece at a time. Cutting every word into tokens was most of the cost,
 * so only the pieces a change touches are.
 */
class Side {
  readonly words: string[] = [];
  private readonly pieceOf: number[] = [];
  private readonly pieces: { seg: number; base: number; text: string; first: number }[] = [];
  private readonly tokens = new Map<number, Token[]>();

  /** `texts` are the lines, or the book's one text; a token's `seg` is its place in them. */
  constructor(texts: readonly string[]) {
    const space = /\s/g;
    texts.forEach((text, seg) => {
      // cut at a space every PIECE characters, so no word or token spans two pieces
      for (let base = 0; base < text.length;) {
        space.lastIndex = base + PIECE;
        const cut = space.exec(text)?.index ?? text.length;
        const piece = text.slice(base, cut);
        const words = wordsOf(piece);
        if (words.length) {
          this.pieces.push({ seg, base, text: piece, first: this.words.length });
          for (const w of words) {
            this.words.push(w);
            this.pieceOf.push(this.pieces.length - 1);
          }
        }
        base = cut + 1;
      }
    });
  }

  /** The token holding word `k`. */
  at(k: number): Token {
    const p = this.pieceOf[k];
    let list = this.tokens.get(p);
    if (!list) {
      const { seg, base, text, first } = this.pieces[p];
      list = [];
      let n = first;
      for (const t of tokensOf(text)) {
        const count = wordsOf(t.text).length;
        if (!count) continue;
        const start = base + t.at;
        const end = start + t.text.trimEnd().length;
        list.push({ seg, start, end, next: start + t.text.length, first: n, count });
        n += count;
      }
      this.tokens.set(p, list);
    }
    return list.find((t) => k < t.first + t.count)!;
  }

  /** The tokens holding words `from` up to `to`. */
  span(from: number, to: number): Token[] {
    const out: Token[] = [];
    for (let k = from; k < to; k = out.at(-1)!.first + out.at(-1)!.count) out.push(this.at(k));
    return out;
  }
}

/** A run of words that differ: `[k0, k1)` of the lines', `[m0, m1)` of the book's. */
interface Change {
  k0: number;
  k1: number;
  m0: number;
  m1: number;
}

/** How far `[lo, hi)` must grow, before and after, to hold whole tokens. */
function toTokens(side: Side, lo: number, hi: number): [number, number] {
  if (lo >= hi) return [0, 0];
  const last = side.at(hi - 1);
  return [lo - side.at(lo).first, last.first + last.count - hi];
}

/**
 * Widen a change to whole tokens on both sides. The words it takes in are common to both, unless
 * it reaches into the change next to it, which then merges with it.
 */
// ponytail: lines split inside a book token ("said—“Halt!”") beside a change fold into the first
function widen(c: Change, line: Side, book: Side): void {
  const grow = (before: number, after: number): void => {
    c.k0 = Math.max(0, c.k0 - before);
    c.m0 = Math.max(0, c.m0 - before);
    c.k1 = Math.min(line.words.length, c.k1 + after);
    c.m1 = Math.min(book.words.length, c.m1 + after);
  };
  for (;;) {
    const [a, b] = toTokens(line, c.k0, c.k1);
    grow(a, b);
    const [x, y] = toTokens(book, c.m0, c.m1);
    grow(x, y);
    if (!(a || b || x || y)) return;
  }
}

interface Edit {
  seg: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Rewrites the lines' words where they differ from `text` (the book's chapter, as plain text), so
 * they read it word for word, with the book's punctuation for the words changed. A changed word
 * goes into the line that held it, a new one into the line holding the word before it. Markers
 * keep their place, or the nearest edge of a changed span. A line left with no words is dropped
 * and the rest renumbered. Mutates `segments`.
 */
export function retext(
  segments: Segment[],
  text: string,
): { segments: Segment[]; retexted: number[] } {
  const line = new Side(segments.map((s) => s.text));
  const book = new Side([text]);

  const changes: Change[] = [];
  let k = 0;
  let m = 0;
  for (const part of diffArrays(line.words, book.words)) {
    if (!part.added && !part.removed) {
      k += part.count;
      m += part.count;
      continue;
    }
    const last = changes.at(-1);
    const c = last && last.k1 === k && last.m1 === m ? last : { k0: k, k1: k, m0: m, m1: m };
    if (c !== last) changes.push(c);
    if (part.removed) c.k1 = k += part.count;
    else c.m1 = m += part.count;
  }

  // Widening can run into the change before; the two become one.
  const merged: Change[] = [];
  for (let c of changes) {
    widen(c, line, book);
    for (
      let prev = merged.at(-1);
      prev && (prev.k1 > c.k0 || prev.m1 > c.m0);
      prev = merged.at(-1)
    ) {
      merged.pop();
      c = {
        k0: Math.min(prev.k0, c.k0),
        k1: Math.max(prev.k1, c.k1),
        m0: Math.min(prev.m0, c.m0),
        m1: Math.max(prev.m1, c.m1),
      };
      widen(c, line, book);
    }
    merged.push(c);
  }

  const edits: Edit[] = [];
  for (const c of merged) {
    const gone = line.span(c.k0, c.k1);
    const come = book.span(c.m0, c.m1).map((t) => text.slice(t.start, t.end));
    gone.forEach((t, i) =>
      edits.push(
        i < come.length
          ? { seg: t.seg, start: t.start, end: t.end, text: come[i] }
          : { seg: t.seg, start: t.start, end: t.next, text: "" },
      ),
    );
    const rest = come.slice(gone.length).join(" ");
    if (!rest) continue;
    const after = gone.at(-1) ?? (c.k0 > 0 ? line.at(c.k0 - 1) : undefined);
    if (after) edits.push({ seg: after.seg, start: after.end, end: after.end, text: ` ${rest}` });
    else if (line.words.length) {
      const head = line.at(0);
      edits.push({ seg: head.seg, start: head.start, end: head.start, text: `${rest} ` });
    }
  }

  // right to left, so each edit's offsets still hold
  edits.sort((a, b) => b.start - a.start);
  const touched = new Set<number>();
  for (const { seg, start, end, text: put } of edits) {
    const s = segments[seg];
    s.text = s.text.slice(0, start) + put + s.text.slice(end);
    for (const a of s.expressions ?? []) {
      if (a.at >= end && (a.at > start || start === end)) a.at += put.length - (end - start);
      else if (a.at > start) a.at = a.at - start <= end - a.at ? start : start + put.length;
    }
    touched.add(seg);
  }

  const kept: Segment[] = [];
  const retexted: number[] = [];
  segments.forEach((s, i) => {
    if (touched.has(i) && !wordsOf(s.text).length) return;
    s.id = kept.push(s);
    if (touched.has(i)) retexted.push(s.id);
  });
  return { segments: kept, retexted };
}
