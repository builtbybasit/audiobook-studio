// The gaps between words in a line (where a segment can be cut or an expression placed), and the
// words themselves as every comparison reads them (`wordsOf`).

export interface WordToken {
  /** the word and the whitespace after it, exactly as in the source */
  text: string;
  /** offset of the gap *before* this token */
  at: number;
  /** the previous token ended a sentence — the likely cut */
  strong: boolean;
}

export interface WordGap {
  at: number;
  strong: boolean;
  /** only offered when placing, never for a cut */
  edge?: "start" | "end";
}

/** Joining the texts back gives the source. */
export function tokensOf(text: string): WordToken[] {
  const out: WordToken[] = [];
  const re = /\S+\s*/g;
  let m: RegExpExecArray | null;
  let strong = false;
  while ((m = re.exec(text))) {
    out.push({ text: m[0], at: m.index, strong });
    strong = /[.!?…][”’"')\]]?\s*$/.test(m[0]);
  }
  return out;
}

/**
 * Lower case, curly quotes folded, punctuation gone, inner apostrophes kept. The one rule for every
 * word comparison (`fidelity`, `alignHeard`).
 */
export function wordsOf(text: string): string[] {
  return folded(text).toLowerCase().match(WORD) ?? [];
}

/** `wordsOf` with capitals kept, to tell a name from a word. */
export function writtenWordsOf(text: string): string[] {
  return folded(text).match(WORD) ?? [];
}

const folded = (text: string): string => text.normalize("NFKC").replace(/[‘’ʼ`´]/g, "'");
const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

/** "split" offers only inner gaps (a cut needs a word on each side); "place" adds the edges. */
export function gapsOf(text: string, mode: "split" | "place"): WordGap[] {
  const tokens = tokensOf(text);
  const inside = tokens.slice(1).map((t) => ({ at: t.at, strong: t.strong }));
  if (mode === "split") return inside;
  return [
    { at: 0, strong: false, edge: "start" },
    ...inside,
    { at: text.length, strong: false, edge: "end" },
  ];
}

export function gapLabel(text: string, at: number, max = 28): string {
  if (at <= 0) return "before the line";
  if (at >= text.length) return "after the line";
  const rest = text.slice(at).trim();
  return `before “${rest.length > max ? rest.slice(0, max).trimEnd() + "…" : rest}”`;
}
