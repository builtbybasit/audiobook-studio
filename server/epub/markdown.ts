// Chapter text is stored as Markdown (Turndown from the EPUB's HTML). Nothing downstream may read
// it as prose: a provider would read `## Heading` and link URLs aloud and bill for them, so
// `plainText` runs a real Markdown parser rather than a regex.
import MarkdownIt, { type Token } from "markdown-it";
import type TurndownService from "turndown";

export type Mark = "em" | "strong";

/** Where a run of stressed words sits, as character offsets into the prose it was read from. */
export interface Emphasis {
  at: number;
  to: number;
  mark: Mark;
}

let converter: Promise<TurndownService> | null = null;

/**
 * CommonMark plus the GFM tables Turndown writes; raw HTML stays text. Not `marked`: under Bun its
 * lexer is superlinear (4,000 paragraphs took 30 s; markdown-it takes 11 ms).
 */
const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });

/** The shape read off Turndown's nodes; the server has no DOM lib types. */
interface StyledNode {
  nodeName?: string;
  parentNode?: StyledNode | null;
  getAttribute?: (name: string) => string | null;
}

interface FigureNode {
  nodeName?: string;
  parentNode?: FigureNode | null;
  querySelector?: (selector: string) => unknown;
}

/** Stress written as styling rather than as an element, as many real EPUBs do. */
const ITALIC = /font-style\s*:\s*(?:italic|oblique)/i;
const BOLD = /font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/i;

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

/** Run `load` with no `window` visible, then put it back. Exported so a test can reach it. */
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
 * Load Turndown with `window` hidden. It picks `window.DOMParser` at module evaluation when one
 * exists (a test stub, or linkedom via epub-ts); bound to linkedom its table plugin stops matching
 * and tables collapse to `DayChapterMondayCh 1`. Hidden, it uses its bundled domino.
 */
function load(): Promise<TurndownService> {
  return withoutWindow(async () => {
    const [{ default: Turndown }, { gfm }] = await Promise.all([
      import("turndown"),
      import("@joplin/turndown-plugin-gfm"),
    ]);
    const service = new Turndown({
      // A setext `====` underline survives a careless strip and gets read aloud.
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });
    // Not `<figure>`: it often holds epigraphs and verse. Only a picture's caption goes, below.
    service.remove(["head", "title", "meta", "link", "script", "style", "nav", "aside", "img"]);
    // By name: Turndown's types don't take `svg` in the list above.
    service.remove((node) => node.nodeName.toLowerCase() === "svg");
    // `remove` doesn't reach `<img>`: Turndown's image rule runs first and writes `![](a.png)`.
    service.addRule("picture", { filter: ["img"], replacement: () => "" });
    // Only a picture's caption; a text figure's caption ("— Emily Dickinson") is read with it.
    service.addRule("pictureCaption", {
      filter: (node: unknown) => {
        const el = node as FigureNode;
        if (el.nodeName !== "FIGCAPTION") return false;
        const figure = el.parentNode;
        return (
          figure?.nodeName === "FIGURE" && !!figure.querySelector?.("img, svg, picture, image")
        );
      },
      replacement: () => "",
    });
    service.use(gfm);
    // Turndown has no rule for `<span style="font-style: italic">`; the archive isn't kept, so
    // stress lost here is lost for good.
    service.addRule("styledStress", {
      filter: (node: unknown) => {
        const el = node as StyledNode;
        return el.nodeName === "SPAN" && marksOf(el).length > 0;
      },
      replacement: (content: string, node: unknown) => {
        const el = node as StyledNode;
        // Turndown moves edge whitespace out of `content`; `* never *` would not be emphasis.
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

/**
 * Walk state. `tail` is the last two characters of `text`, tracked separately: `text.endsWith`
 * per block is quadratic under Bun, which flattens a `+=` rope first.
 */
interface Walk {
  text: string;
  tail: string;
  emphasis: Emphasis[];
}

const push = (w: Walk, s: string): void => {
  if (!s) return;
  w.text += s;
  w.tail = (w.tail + s).slice(-2);
};

/** End the current block, if there is one, with the blank line that separates blocks. */
function endBlock(w: Walk): void {
  if (w.text && w.tail !== "\n\n") push(w, w.tail.endsWith("\n") ? "\n" : "\n\n");
}

/** markdown-it's flat token stream: a block ends where its token closes. */
function walk(w: Walk, tokens: readonly Token[]): void {
  let cell = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case "heading_open":
      case "heading_close":
      case "paragraph_open":
      case "paragraph_close":
      case "blockquote_open":
      case "blockquote_close":
      case "bullet_list_open":
      case "ordered_list_open":
      case "list_item_close":
      case "table_open":
      case "hr":
        endBlock(w);
        break;
      case "thead_open": {
        // A table with no `<th>` converts with an empty header row; skip it so speech doesn't
        // open on a comma.
        const close = tokens.findIndex((t, at) => at > i && t.type === "thead_close");
        const head = tokens.slice(i, close);
        if (!head.some((t) => t.type === "inline" && t.content.trim())) i = close;
        break;
      }
      // A table reads a row at a time, cells separated by commas.
      case "tr_open":
        cell = 0;
        break;
      case "th_open":
      case "td_open":
        if (cell++) push(w, ", ");
        break;
      case "tr_close":
        endBlock(w);
        break;
      case "fence":
      case "code_block":
        endBlock(w);
        push(w, token.content.replace(/\n$/, ""));
        endBlock(w);
        break;
      case "inline":
        inline(w, token.children ?? []);
        break;
    }
  }
}

/** One inline run: its words, and where its stress opened and closed. */
function inline(w: Walk, tokens: readonly Token[]): void {
  const open: Record<Mark, number[]> = { em: [], strong: [] };
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "code_inline":
      case "html_inline":
        push(w, token.content);
        break;
      case "softbreak":
      case "hardbreak":
        push(w, "\n");
        break;
      case "em_open":
      case "strong_open":
        open[token.tag === "em" ? "em" : "strong"].push(w.text.length);
        break;
      case "em_close":
      case "strong_close": {
        const mark: Mark = token.tag === "em" ? "em" : "strong";
        const at = open[mark].pop();
        if (at != null && w.text.length > at) w.emphasis.push({ at, to: w.text.length, mark });
        break;
      }
      // Images (and their alt-text children) are skipped; a link is its words, never its URL.
    }
  }
}

/**
 * The runs of the walked prose that survive trimming and collapsing extra newlines, as `[from, to)`
 * into the untidied text, so emphasis offsets can be moved with the text (see `moved`).
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

/** Where an offset into the untidied prose ends up once the kept runs are joined. */
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
 * The prose and where its stress falls. Ranges are offsets into `text` and may overlap
 * (`***never***`). Fine for rendering; storage keeps the Markdown, not these offsets.
 */
export function parseEmphasis(markdown: string): { text: string; emphasis: Emphasis[] } {
  const w: Walk = { text: "", tail: "", emphasis: [] };
  walk(w, parser.parse(markdown, {}));
  const kept = keptRuns(w.text);
  const text = kept.map(([from, to]) => w.text.slice(from, to)).join("");
  const emphasis = w.emphasis
    .map((e) => ({ at: moved(kept, e.at), to: moved(kept, e.to), mark: e.mark }))
    // A run that was only trimmed whitespace marks nothing.
    .filter((e) => e.at < e.to);
  // Outermost first, then by name, so the order is stable.
  emphasis.sort(
    (a, b) => a.at - b.at || b.to - a.to || (a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0),
  );
  return { text, emphasis };
}

/** The prose with no Markdown. Anything that counts, bills or speaks a chapter reads this. */
export const plainText = (markdown: string): string => parseEmphasis(markdown).text;
