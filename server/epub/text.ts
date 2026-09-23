// Cutting one EPUB section into the chapters it holds, and handing each to the converter.
//
// The conversion itself is not here — `server/epub/markdown.ts` owns that, because turning
// arbitrary publisher HTML into readable text is a long tail somebody else has already walked.
// What is here is the part no converter can do: most web-novel EPUBs pack several chapters into one
// XHTML file and point the table of contents at an anchor inside it, so the file has to be cut into
// fragments *before* anything converts it.
//
// It cuts HTML rather than text, and hands the converter strings rather than the nodes it already
// has parsed. Both are deliberate — see `toMarkdown`, which is tested against its own DOM and
// quietly loses tables when given somebody else's.
import { parseHTML } from "linkedom";

import { toMarkdown } from "~/epub/markdown";

/** The shape this reads off linkedom's nodes, rather than the DOM lib the server does not have. */
interface Node {
  nodeType: number;
  nodeValue: string | null;
  parentNode?: Node | null;
}
interface Element extends Node {
  tagName?: string;
  childNodes: ArrayLike<Node>;
  outerHTML?: string;
  getAttribute?: (name: string) => string | null;
  getAttributeNames?: () => string[];
}
interface Doc {
  documentElement?: Element | null;
  body?: Element | null;
  getElementById?: (id: string) => Element | null;
  querySelector?: (selector: string) => Element | null;
}

/** One chapter's worth of a section: everything from one navigation anchor to the next. */
export interface TextPart {
  /** the anchor the navigation pointed at, or null for the text before the first one */
  id: string | null;
  /** the chapter, as Markdown */
  text: string;
}

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

/**
 * The elements whose wrapper has to survive a cut through them.
 *
 * The walk below descends into an element only when an anchor sits inside it, and what it emits
 * then is that element's children — the wrapper itself is gone. For a block that is the point: a
 * chapter that begins halfway through a paragraph ends that paragraph. For an inline element it is
 * a loss with nowhere to appeal to, because the archive is not kept: a chapter that begins inside
 * `<em>` would arrive with the emphasis silently gone from both halves of it.
 */
const INLINE = new Set([
  "a",
  "abbr",
  "b",
  "big",
  "cite",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "var",
]);

/** The tags that reopen an inline element after a cut, attributes and all — `style` marks stress. */
function wrapperOf(el: Element): { open: string; close: string } | null {
  const tag = (el.tagName ?? "").toLowerCase();
  if (!INLINE.has(tag)) return null;
  const attributes = (el.getAttributeNames?.() ?? [])
    .map((name) => ` ${name}="${escapeAttr(el.getAttribute?.(name) ?? "")}"`)
    .join("");
  return { open: `<${tag}${attributes}>`, close: `</${tag}>` };
}

/** The element an anchor names, by `id` or by the `name` older books used. */
function anchorElement(document: Doc, id: string): Element | null {
  const byId = document.getElementById?.(id);
  if (byId) return byId;
  const quoted = id.replace(/["\\]/g, "\\$&");
  return document.querySelector?.(`[name="${quoted}"]`) ?? null;
}

/**
 * Cut a section into the HTML fragments the navigation says it holds.
 *
 * An element is taken **whole** unless an anchor lives somewhere inside it, in which case the walk
 * descends and that element's own wrapper is the thing being split. Taking elements whole is what
 * keeps the markup intact for the converter: a list, a table or a blockquote arrives as a list, a
 * table or a blockquote rather than as the text that was in it.
 */
function cut(document: Doc, anchors: readonly string[]): TextPart[] {
  const parts: { id: string | null; html: string[] }[] = [{ id: null, html: [] }];
  const wanted = new Set(anchors);
  // The inline elements the walk is currently inside, outermost first. A cut closes all of them in
  // the part it ends and opens them again in the part it starts, so neither half is left with an
  // emphasis that only had an opening tag.
  const open: { open: string; close: string }[] = [];

  const startPart = (id: string): void => {
    const ending = parts[parts.length - 1].html;
    for (let i = open.length - 1; i >= 0; i--) ending.push(open[i].close);
    parts.push({ id, html: open.map((wrapper) => wrapper.open) });
  };

  // Every element an anchor sits inside, so the walk knows where it has to descend and where it can
  // take the markup whole. Worked out up front: asking "is there an anchor below me" at each level
  // instead would re-walk the same subtrees once per level.
  const onPath = new Set<Element>();
  for (const id of anchors) {
    let node = anchorElement(document, id)?.parentNode as Element | null | undefined;
    while (node && !onPath.has(node)) {
      onPath.add(node);
      node = node.parentNode as Element | null | undefined;
    }
  }

  const visit = (parent: Element): void => {
    for (const child of Array.from(parent.childNodes)) {
      const here = parts[parts.length - 1].html;
      if (child.nodeType === 3) {
        here.push(escapeText(child.nodeValue ?? ""));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      // Either attribute can be the one the navigation named: `<a name="ch3" id="calibre_link-7">`
      // is how converters leave an older book, and the link still says `#ch3`.
      const id = [el.getAttribute?.("id"), el.getAttribute?.("name")].find(
        (name): name is string => !!name && wanted.has(name),
      );
      if (id) {
        startPart(id);
        wanted.delete(id);
      }
      if (!onPath.has(el)) {
        parts[parts.length - 1].html.push(el.outerHTML ?? "");
        continue;
      }
      const wrapper = wrapperOf(el);
      if (wrapper) {
        parts[parts.length - 1].html.push(wrapper.open);
        open.push(wrapper);
      }
      visit(el);
      if (wrapper) {
        open.pop();
        parts[parts.length - 1].html.push(wrapper.close);
      }
    }
  };

  const root = document.documentElement ?? document.body ?? null;
  if (root) visit(root);
  return parts.map((p) => ({ id: p.id, text: p.html.join("") }));
}

/**
 * Read a section, split where the navigation says a new chapter starts inside it.
 *
 * `anchors` are element ids the table of contents pointed at. A part is returned for each one the
 * document actually contains, in document order, preceded by whatever came before the first — so a
 * caller can tell "the file had no such id" from "the id was there and the chapter was empty",
 * which are two different problems with the file.
 */
export async function sectionParts(
  html: string,
  anchors: readonly string[] = [],
): Promise<TextPart[]> {
  // Nothing to cut: hand the file over as it stands, which is the common case and the one where
  // re-serialising a parsed document could only lose something.
  if (!anchors.length) return [{ id: null, text: await toMarkdown(html) }];

  // `documentElement`, not `body`: a section rendered as a bare fragment parses with its content
  // under the root element and an empty `body` beside it, and walking `body` would find nothing.
  const { document } = parseHTML(html);
  const parts = cut(document as unknown as Doc, anchors);
  return Promise.all(
    parts.map(async (part) => ({ id: part.id, text: await toMarkdown(part.text) })),
  );
}

/** One whole section as Markdown, for a file the navigation does not cut up. */
export async function sectionText(html: string): Promise<string> {
  return (await sectionParts(html))[0].text;
}

/**
 * How many words a chapter is.
 *
 * Counted on whitespace-separated runs that contain at least one letter or digit, so a line of
 * dashes or a row of quotation marks does not inflate the figure the review and the run estimates
 * are both read from. CJK text has no spaces, so its characters are counted directly and scaled:
 * a "word" of Chinese prose is roughly 1.6 characters, which keeps a translated chapter's estimate
 * in the same range as an English one rather than an order of magnitude out.
 *
 * Takes **prose**, never the stored Markdown: callers run `plainText` first. Stripping in here
 * instead would mean stripping text that has already been stripped, and a `*` that a novel used as
 * a scene break would be read as emphasis the second time round and quietly deleted.
 */
export function countWords(prose: string): number {
  const cjk = prose.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿]/g)?.length ?? 0;
  const latin = prose
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w) && !/^[぀-ヿ㐀-鿿]+$/u.test(w)).length;
  return latin + Math.round(cjk / 1.6);
}
