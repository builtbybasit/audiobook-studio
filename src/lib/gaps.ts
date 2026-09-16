// The gaps between words in a line: where a segment can be cut, and where an expression can be
// placed. Pure over the text, so the strip, the editor and the tests agree on what a gap is.

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
  /** the edge of the line, only offered when placing something, never for a cut */
  edge?: "start" | "end";
}

/** Words with the whitespace that follows each, so joining the texts back gives the source. */
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
 * The gaps of a line. A cut needs a word on each side, so "split" offers only the gaps inside;
 * "place" offers the two edges as well.
 */
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

/** What a gap is called: before the words that follow it, or an edge of the line. */
export function gapLabel(text: string, at: number, max = 28): string {
  if (at <= 0) return "before the line";
  if (at >= text.length) return "after the line";
  const rest = text.slice(at).trim();
  return `before “${rest.length > max ? rest.slice(0, max).trimEnd() + "…" : rest}”`;
}
