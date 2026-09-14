// Splitting a segment that is longer than an endpoint's per-request limit. The endpoint chooses
// where cuts may fall; when the preferred boundary doesn't exist inside the window we fall back
// down the chain (sentence → clause → word → hard cut) and mark that part so the UI can say so.
import type { Cut, Endpoint, SplitMode } from "@/types";

export interface SplitModeOption {
  value: SplitMode;
  label: string;
  hint: string;
}

export const SPLIT_MODES: SplitModeOption[] = [
  { value: "sentence", label: "Sentence end", hint: ". ! ? …" },
  { value: "clause", label: "Clause", hint: ", ; : —" },
  { value: "word", label: "Word", hint: "last space" },
  { value: "char", label: "Hard cut", hint: "exactly at the limit" },
];
const CHAIN: SplitMode[] = ["sentence", "clause", "word", "char"];

export interface SplitPart extends Cut {
  text: string;
}

// last boundary of `mode` at or before `max` (index where the next part starts), or -1
function lastBoundary(text: string, max: number, mode: SplitMode): number {
  const win = text.slice(0, max + 1);
  const re =
    mode === "sentence"
      ? /[.!?…]+["'’”)\]]*\s+/g
      : mode === "clause"
        ? /(?:[.!?…]+["'’”)\]]*|[,;:—–])\s+/g
        : mode === "word"
          ? /\s+/g
          : null;
  if (!re) return max;
  let best = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(win))) {
    const end = m.index + m[0].length;
    if (end <= max && end > 0) best = end;
  }
  return best;
}

// → [{ text, from, to, at, fallback }] ; `at` is the boundary actually used for the cut *after* this part
export function splitText(
  text: string,
  maxChars: number,
  mode: SplitMode = "sentence",
): SplitPart[] {
  if (!maxChars || text.length <= maxChars)
    return [{ text, from: 0, to: text.length, at: null, fallback: false }];
  const parts: SplitPart[] = [];
  let pos = 0;
  const start = Math.max(0, CHAIN.indexOf(mode));
  while (text.length - pos > maxChars) {
    const rest = text.slice(pos);
    let cut = -1;
    let used: SplitMode | null = null;
    for (let i = start; i < CHAIN.length; i++) {
      cut = lastBoundary(rest, maxChars, CHAIN[i]);
      if (cut > 0) {
        used = CHAIN[i];
        break;
      }
    }
    const piece = rest.slice(0, cut);
    parts.push({
      text: piece.trimEnd(),
      from: pos,
      to: pos + piece.trimEnd().length,
      at: used,
      fallback: used !== mode,
    });
    pos += cut;
    while (text[pos] === " ") pos++;
  }
  parts.push({ text: text.slice(pos), from: pos, to: text.length, at: null, fallback: false });
  return parts;
}

export const partsFor = (
  text: string,
  ep: Pick<Endpoint, "maxChars" | "splitAt"> | null | undefined,
): number => (ep?.maxChars ? splitText(text, ep.maxChars, ep.splitAt ?? "sentence").length : 1);
