// Cuts one EPUB section into the chapters it holds before conversion (`server/epub/markdown.ts`):
// web-novel EPUBs pack several chapters per XHTML file, with the TOC pointing at anchors. It cuts
// HTML and hands the converter strings, not nodes: Turndown loses tables on a foreign DOM.
import { parseHTML } from "linkedom";

import { toMarkdown } from "~/epub/markdown";

/** The shape read off linkedom's nodes; the server has no DOM lib types. */
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
  /** Markdown */
  text: string;
}

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

/**
 * Elements whose wrapper must survive a cut through them. A cut drops the wrapper it descends
 * into: right for a block, but a cut inside `<em>` would lose the emphasis from both halves.
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
 * Cut a section into the HTML fragments the navigation says it holds. An element is taken whole
 * (keeping lists and tables intact) unless an anchor sits inside it.
 */
function cut(document: Doc, anchors: readonly string[]): TextPart[] {
  const parts: { id: string | null; html: string[] }[] = [{ id: null, html: [] }];
  const wanted = new Set(anchors);
  // Inline elements the walk is inside, outermost first; a cut closes and reopens them.
  const open: { open: string; close: string }[] = [];

  const startPart = (id: string): void => {
    const ending = parts[parts.length - 1].html;
    for (let i = open.length - 1; i >= 0; i--) ending.push(open[i].close);
    parts.push({ id, html: open.map((wrapper) => wrapper.open) });
  };

  // Ancestors of every anchor, computed once so the walk doesn't re-scan subtrees per level.
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
      // Either attribute may be the target: `<a name="ch3" id="calibre_link-7">` linked as `#ch3`.
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
 * Read a section, split at the TOC's `anchors`. Returns a part per anchor the document contains,
 * in document order, preceded by the text before the first; a missing id yields no part.
 */
export async function sectionParts(
  html: string,
  anchors: readonly string[] = [],
): Promise<TextPart[]> {
  // Nothing to cut: re-serialising a parsed document could only lose something.
  if (!anchors.length) return [{ id: null, text: await toMarkdown(html) }];

  // `cut` walks `documentElement`: a bare fragment parses with an empty `body`.
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
 * Words in a chapter: whitespace runs with a letter or digit, plus CJK characters / 1.6 (about one
 * Chinese "word"). Takes prose (`plainText` first), never stored Markdown.
 */
export function countWords(prose: string): number {
  const cjk = prose.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿]/g)?.length ?? 0;
  const latin = prose
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w) && !/^[぀-ヿ㐀-鿿]+$/u.test(w)).length;
  return latin + Math.round(cjk / 1.6);
}
