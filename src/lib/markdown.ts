// A chapter's stored Markdown as pieces `src/components/MarkdownText.vue` draws as Vue elements;
// the book's text is never rendered as HTML. Which links are followable is a security rule.
import { marked, type Token, type Tokens } from "marked";

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "em" | "strong" | "both"; text: string }
  | { kind: "link"; pieces: Piece[]; href: string | null };

/**
 * Anything else (`javascript:`, `data:`, relative links into the discarded archive) is drawn as
 * its words with no target.
 */
const SAFE = /^(?:https?:|mailto:)/i;

export const safeHref = (href: string): string | null => {
  const trimmed = href.trim();
  // a browser ignores control characters and spaces, so `java\nscript:` is `javascript:` to it
  const bare = Array.from(trimmed)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join("");
  return SAFE.test(bare) ? trimmed : null;
};

export const blocksOf = (markdown: string): Token[] => marked.lexer(markdown);

/** `within` is the stress already open, so `***never***` arrives as one `both` piece. */
export function piecesOf(
  tokens: readonly Token[] | undefined,
  raw = "",
  within: "" | "em" | "strong" | "both" = "",
): Piece[] {
  if (!tokens?.length) return raw ? [{ kind: within || "text", text: raw } as Piece] : [];
  const out: Piece[] = [];
  for (const token of tokens) {
    const t = token as Tokens.Generic & { tokens?: Token[]; text?: string; href?: string };
    switch (token.type) {
      case "em":
      case "strong": {
        const mark = within && within !== token.type ? "both" : (token.type as "em" | "strong");
        out.push(...piecesOf(t.tokens, t.text ?? "", mark));
        break;
      }
      case "link":
        // the link's tokens, not `text`, which would draw the stars of `[*the note*](…)`
        out.push({
          kind: "link",
          pieces: piecesOf(t.tokens, t.text ?? "", within),
          href: safeHref(t.href ?? ""),
        });
        break;
      // nothing is kept from the archive, and alt text is not prose
      case "image":
        break;
      case "br":
        out.push({ kind: "text", text: "\n" });
        break;
      default:
        if (t.tokens?.length) out.push(...piecesOf(t.tokens, "", within));
        else if (t.text) out.push({ kind: within || "text", text: t.text } as Piece);
    }
  }
  return out;
}

export const inlineOf = (token: Token): Piece[] =>
  piecesOf((token as { tokens?: Token[] }).tokens, (token as { text?: string }).text ?? "");

export interface Row {
  head: boolean;
  cells: Tokens.TableCell[];
}

/** Header first. An empty header row (a table with no `<th>`) is left out. */
export const rowsOf = (token: Tokens.Table): Row[] => [
  ...(token.header.some((cell) => cell.text?.trim()) ? [{ head: true, cells: token.header }] : []),
  ...token.rows.map((cells) => ({ head: false, cells })),
];
