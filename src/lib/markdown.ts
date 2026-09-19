// Reading a chapter's stored Markdown into something a template can draw.
//
// A plain module rather than logic inside the component, because what it decides is not cosmetic:
// the text came out of a file somebody uploaded, and the rule about which links are followable is
// the kind of thing that has to be testable on its own. The renderer in
// `src/components/MarkdownText.vue` turns what this returns into elements Vue builds itself —
// nothing anywhere renders the book's characters as HTML.
import { marked, type Token, type Tokens } from "marked";

/** One drawable piece of an inline run. */
export type Piece =
  | { kind: "text"; text: string }
  | { kind: "em" | "strong" | "both"; text: string }
  | { kind: "link"; pieces: Piece[]; href: string | null };

/**
 * The schemes a book has any business linking to.
 *
 * `javascript:` and `data:` in an href are the other half of "import this EPUB", and a relative
 * link points inside an archive that is not kept. A link that is not one of these is shown as its
 * words with nothing to click — the text is never dropped, only the target.
 */
const SAFE = /^(?:https?:|mailto:)/i;

export const safeHref = (href: string): string | null => {
  const trimmed = href.trim();
  // Everything up to and including a space comes out before the scheme is read: a browser ignores
  // those, so `java\nscript:` is `javascript:` to it and something else entirely to a plain regex.
  const bare = Array.from(trimmed)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join("");
  return SAFE.test(bare) ? trimmed : null;
};

/** The blocks of a Markdown document, in order. */
export const blocksOf = (markdown: string): Token[] => marked.lexer(markdown);

/**
 * Flatten an inline run to pieces.
 *
 * `within` carries the stress already open over these tokens, so `***never***` arrives as one
 * `both` piece rather than as an `em` nested in a `strong` that the template would have to unpick.
 */
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
        // The words of a link are an inline run like any other: `[*the note*](…)` is an italic
        // link, and `**[the note](…)**` a bold one. Reading `text` instead would draw the stars.
        out.push({
          kind: "link",
          pieces: piecesOf(t.tokens, t.text ?? "", within),
          href: safeHref(t.href ?? ""),
        });
        break;
      // Nothing is kept from the archive, so there is no image to draw and its alt text is not prose.
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

/** The inline run of one block. */
export const inlineOf = (token: Token): Piece[] =>
  piecesOf((token as { tokens?: Token[] }).tokens, (token as { text?: string }).text ?? "");

/** One row of a table, and whether it is the header row the file gave it. */
export interface Row {
  head: boolean;
  cells: Tokens.TableCell[];
}

/**
 * A table's rows, header first, so the template draws one list.
 *
 * A table with no `<th>` — which is how a good deal of older prose is laid out — converts with an
 * empty header row above it. Drawn, that is a blank first row; it is left out here and stays in the
 * stored Markdown, where it is the table's shape rather than a row of the book.
 */
export const rowsOf = (token: Tokens.Table): Row[] => [
  ...(token.header.some((cell) => cell.text?.trim()) ? [{ head: true, cells: token.header }] : []),
  ...token.rows.map((cells) => ({ head: false, cells })),
];
