// Chapter text, as Markdown, and the two ways back out of it.
//
// The stored form of a chapter is Markdown: headings, emphasis, lists, links and tables, as the
// EPUB had them. It is produced by Turndown rather than by hand, because "turn arbitrary publisher
// HTML into readable text" has a long tail — nested lists, `<br>` inside a paragraph, entities,
// whitespace that is significant in one element and not the next — and a converter with eight
// million weekly downloads has met more of that tail than this project ever will.
//
// The way back matters just as much. **Nothing downstream may read the stored text as if it were
// prose.** `## Chapter Twelve`, `[the note](http://x.y)` and `| Day | Chapter |` are all things a
// speech provider would read out loud and bill for, so `plainText` runs a real Markdown parser
// rather than a regex that strips the punctuation somebody remembered.
import { marked } from "marked";
import type { Token, Tokens } from "marked";
import type TurndownService from "turndown";

/** The two grades of stress a book can ask for, kept apart because the file kept them apart. */
export type Mark = "em" | "strong";

/** Where a run of stressed words sits, as character offsets into the prose it was read from. */
export interface Emphasis {
  at: number;
  to: number;
  mark: Mark;
}

let converter: Promise<TurndownService> | null = null;

/** The shape this reads off Turndown's nodes, rather than the DOM lib the server does not have. */
interface StyledNode {
  nodeName?: string;
  parentNode?: StyledNode | null;
  getAttribute?: (name: string) => string | null;
}

/** Stress written as styling rather than as an element, which is how a lot of real EPUBs write it. */
const ITALIC = /font-style\s*:\s*(?:italic|oblique)/i;
const BOLD = /font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/i;

/** What an element stresses, whether it says so in its tag name or in its own `style`. */
function marksOf(node: StyledNode): Mark[] {
  const tag = (node.nodeName ?? "").toLowerCase();
  const style = node.getAttribute?.("style") ?? "";
  const out: Mark[] = [];
  if (tag === "em" || tag === "i" || ITALIC.test(style)) out.push("em");
  if (tag === "strong" || tag === "b" || BOLD.test(style)) out.push("strong");
  return out;
}

/** Whether something above already stresses this the same way: `*` inside `*` reads as `**`. */
function stressedAbove(node: StyledNode, mark: Mark): boolean {
  for (let up = node.parentNode; up; up = up.parentNode)
    if (marksOf(up).includes(mark)) return true;
  return false;
}

/**
 * Run `load` with no `window` visible, and put back whatever was there.
 *
 * Its own function, and exported, because it is the whole of the fix below and it runs exactly once
 * per process — cached behind `converter`, where no test could reach it a second time. A bracket
 * that is only ever exercised on a path nobody can re-enter is a bracket nobody can check.
 */
export async function withoutWindow<T>(load: () => Promise<T>): Promise<T> {
  const globals = globalThis as { window?: unknown };
  const had = "window" in globals;
  const saved = globals.window;
  if (had) delete globals.window;
  try {
    return await load();
  } finally {
    if (had) globals.window = saved;
  }
}

/**
 * Load Turndown, with the DOM it will use pinned to its own.
 *
 * Turndown picks its HTML parser **once, when the module is first evaluated**:
 *
 * ```js
 * var root = typeof window !== 'undefined' ? window : {};
 * var HTMLParser = canParseHTMLNatively() ? root.DOMParser : createHTMLParser();
 * ```
 *
 * With no `window` it falls back to the `@mixmark-io/domino` it ships with, which is what it is
 * tested against. With a `window` carrying a `DOMParser` it takes that instead — and this project
 * has both halves of that trap: the frontend tests install a small `window` stub, and importing
 * `@likecoin/epub-ts/node` registers linkedom's `DOMParser`. Bound to linkedom, Turndown's table
 * plugin stops matching and a table collapses to `DayChapterMondayCh 1`, which is precisely the
 * `textContent` damage this file exists to avoid. Silently, and only in some import orders.
 *
 * So the import is bracketed: whatever `window` is around is hidden for the one moment that
 * decision is made, and Turndown binds the DOM it was tested against every time.
 */
function load(): Promise<TurndownService> {
  return withoutWindow(async () => {
    const [{ default: Turndown }, { gfm }] = await Promise.all([
      import("turndown"),
      import("@joplin/turndown-plugin-gfm"),
    ]);
    const service = new Turndown({
      // `#` over the `====` underline: a setext heading is two lines where one will do, and the
      // underline is the kind of thing that survives a careless strip and gets read aloud.
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });
    // Not prose a narrator reads: the document head, whose <title> repeats the chapter heading
    // underneath it; scripts and styling; the table of contents; an image we do not keep; the
    // caption of a picture the audiobook cannot show; a sidebar nobody is narrating.
    service.remove([
      "head",
      "title",
      "meta",
      "link",
      "script",
      "style",
      "nav",
      "figure",
      "figcaption",
      "aside",
      "svg",
      "img",
    ]);
    service.use(gfm);
    // Stress a publisher wrote as styling. Turndown's own rules match `<em>`, `<i>`, `<strong>` and
    // `<b>`; a word stressed as `<span style="font-style: italic">` reaches them as a span they have
    // no rule for and comes out as unmarked text. The archive is not kept, so a mark lost here is
    // lost for good — and "what the file stressed stays stressed" is what the import promises.
    service.addRule("styledStress", {
      filter: (node: unknown) => {
        const el = node as StyledNode;
        return el.nodeName === "SPAN" && marksOf(el).length > 0;
      },
      replacement: (content: string, node: unknown) => {
        const el = node as StyledNode;
        // Turndown moves the whitespace either side of an inline element out of `content` for us,
        // which matters: `* never *` is not emphasis to any Markdown parser.
        const marks = marksOf(el).filter((mark) => !stressedAbove(el, mark));
        if (!content.trim() || !marks.length) return content;
        const delimiter =
          (marks.includes("strong") ? "**" : "") + (marks.includes("em") ? "*" : "");
        return delimiter + content + delimiter;
      },
    });
    return service;
  });
}

/** One section's HTML as Markdown. */
export async function toMarkdown(html: string): Promise<string> {
  const service = await (converter ??= load());
  return service.turndown(html).trim();
}

/** Walk state: the prose built so far, and where its stress fell. */
interface Walk {
  text: string;
  emphasis: Emphasis[];
}

const push = (w: Walk, s: string): void => {
  w.text += s;
};

/** End the current block, if there is one, with the blank line that separates blocks. */
function endBlock(w: Walk): void {
  if (w.text && !w.text.endsWith("\n\n")) w.text += w.text.endsWith("\n") ? "\n" : "\n\n";
}

function inline(w: Walk, tokens: readonly Token[] | undefined, raw = ""): void {
  if (!tokens?.length) {
    push(w, raw);
    return;
  }
  for (const token of tokens) walk(w, token);
}

/** A stressed run: the prose goes in, and where it landed is recorded beside it. */
function stressed(w: Walk, mark: Mark, t: { tokens?: Token[]; text?: string }): void {
  const at = w.text.length;
  inline(w, t.tokens, t.text ?? "");
  if (w.text.length > at) w.emphasis.push({ at, to: w.text.length, mark });
}

function walk(w: Walk, token: Token): void {
  switch (token.type) {
    case "heading":
      endBlock(w);
      inline(w, token.tokens, token.text);
      endBlock(w);
      return;
    case "paragraph":
      endBlock(w);
      inline(w, token.tokens, token.text);
      endBlock(w);
      return;
    case "blockquote":
      endBlock(w);
      for (const t of token.tokens ?? []) walk(w, t);
      endBlock(w);
      return;
    case "list":
      endBlock(w);
      for (const item of token.items) {
        for (const t of item.tokens ?? []) walk(w, t);
        endBlock(w);
      }
      return;
    case "table": {
      endBlock(w);
      // A table read aloud is a row at a time, cells separated by a pause's worth of punctuation.
      // The pipes and the `---` rule are layout and are not said.
      const row = (cells: Tokens.TableCell[]): void => {
        cells.forEach((cell, i) => {
          if (i) push(w, ", ");
          inline(w, cell.tokens, cell.text);
        });
        endBlock(w);
      };
      // A table with no `<th>` — which is how a good deal of older prose is laid out — converts
      // with an empty header row above it. Read out, that is a row of nothing: the chapter would
      // open on a comma. The row stays in the stored Markdown, where it is the table's shape.
      if (token.header.some((cell: Tokens.TableCell) => cell.text?.trim())) row(token.header);
      for (const cells of token.rows) row(cells);
      return;
    }
    case "code":
      endBlock(w);
      push(w, token.text);
      endBlock(w);
      return;
    case "hr":
      endBlock(w);
      return;
    case "em":
      stressed(w, "em", token);
      return;
    case "strong":
      stressed(w, "strong", token);
      return;
    case "del":
    case "link":
      // The words, never the address. A URL spoken out is a minute of narrated punctuation.
      inline(w, token.tokens, token.text);
      return;
    case "image":
      return;
    case "br":
      push(w, "\n");
      return;
    case "space":
      return;
    case "codespan":
    case "text":
    case "escape":
    case "html":
      inline(w, (token as Tokens.Text).tokens, (token as Tokens.Text).text);
      return;
    default:
      inline(w, (token as { tokens?: Token[] }).tokens, (token as { text?: string }).text ?? "");
  }
}

/**
 * The runs of the walked prose that survive tidying it, as `[from, to)` into the untidied text.
 *
 * The walk ends every block with a blank line whether or not another one follows, so what it leaves
 * has runs of newlines inside it and whitespace around it. Cutting those out moves every character
 * after them — and the offsets beside the text were measured before the cut. Tidying by hand rather
 * than with `replace` and `trim` is what makes the second half possible: the ranges move with the
 * text instead of being left pointing a word or two to the left of where their words ended up.
 */
function keptRuns(raw: string): [number, number][] {
  const first = raw.length - raw.trimStart().length;
  const last = raw.trimEnd().length;
  if (last <= first) return [];
  const runs: [number, number][] = [];
  let from = first;
  for (const run of raw.slice(first, last).matchAll(/\n{3,}/g)) {
    // The first two newlines are the blank line that separates two blocks; the rest is padding.
    const cut = first + run.index + 2;
    runs.push([from, cut]);
    from = cut + run[0].length - 2;
  }
  runs.push([from, last]);
  return runs;
}

/** Where an offset into the untidied prose ended up once the runs above were joined together. */
function moved(runs: readonly [number, number][], at: number): number {
  let out = 0;
  for (const [from, to] of runs) {
    if (at < from) return out;
    if (at < to) return out + (at - from);
    out += to - from;
  }
  return out;
}

/**
 * The prose and where its stress falls — what the stored Markdown actually says.
 *
 * Ranges are offsets into `text` and may overlap, because `***never***` is a word that is both.
 * They are right for a renderer or for a provider's emphasis markup, which read a string they are
 * about to use and do not change it; they are wrong for storage, which is why the stored form is
 * the Markdown and this is computed from it rather than the other way round.
 */
export function parseEmphasis(markdown: string): { text: string; emphasis: Emphasis[] } {
  const w: Walk = { text: "", emphasis: [] };
  for (const token of marked.lexer(markdown)) walk(w, token);
  const kept = keptRuns(w.text);
  const text = kept.map(([from, to]) => w.text.slice(from, to)).join("");
  const emphasis = w.emphasis
    .map((e) => ({ at: moved(kept, e.at), to: moved(kept, e.to), mark: e.mark }))
    // A run that was nothing but the whitespace the tidy-up took out marks no words at all.
    .filter((e) => e.at < e.to);
  // Outermost first where they differ, and by name where they do not, so a caller applying them
  // does not have to guess which order it gets.
  emphasis.sort(
    (a, b) => a.at - b.at || b.to - a.to || (a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0),
  );
  return { text, emphasis };
}

/**
 * The prose with no Markdown in it at all.
 *
 * **Anything that counts, bills or speaks a chapter reads this**, never the stored column. A
 * provider sent the stored form would narrate the heading marks and read a link's address out.
 */
export const plainText = (markdown: string): string => parseEmphasis(markdown).text;
