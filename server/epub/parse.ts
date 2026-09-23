// Reading an actual EPUB.
//
// This is the one place in the app that opens a real file. It hands back what the import needs and
// nothing more: the book's title and author, and its chapters in reading order with their text.
// Deciding which of those chapters are story is `server/epub/notices.ts`; turning them into a book
// is `server/import/assemble.ts`.
//
// Built on the Node entry point of @likecoin/epub-ts: `packaging.metadata` is synchronous once the
// package document is parsed, and a section renders through the archive's own request function, so
// nothing here reaches the network. The `/node` entry registers linkedom's DOMParser itself —
// calling `setDOMParser` is not required.
import type { Book } from "@likecoin/epub-ts/node";

import { numericEntities } from "~/epub/entities";
import { plainText } from "~/epub/markdown";
import { countWords, sectionParts } from "~/epub/text";

type BookClass = new (url?: ConstructorParameters<typeof Book>[0]) => Book;
let cached: BookClass | null = null;

/**
 * Load the EPUB library, with its two import-time side effects contained.
 *
 * It is loaded here rather than at the top of the file because both fixes have to bracket the
 * import itself, and an `import` statement gives nowhere to stand.
 *
 * Going in: the bundle reads `typeof window < "u" ? window.requestAnimationFrame.bind(window)`,
 * which takes any `window` at all for a complete browser one. That holds in a browser and in a
 * bare server process, and fails in between — a test run where a frontend module has installed a
 * small `window` stub, where it throws on import and takes the whole file with it.
 *
 * Coming out: the import installs linkedom's `DOMParser` and a global `document`. The parser needs
 * the first. The second is a server process announcing itself as a browser, which is false and has
 * consequences: code that branches on `typeof document` takes the DOM path and then reaches for
 * the rest of a browser that is not there.
 *
 * Both are put back the way they were found, so loading the parser leaves no trace in the globals.
 */
async function loadBookClass(): Promise<BookClass> {
  if (cached) return cached;
  const globals = globalThis as {
    window?: { requestAnimationFrame?: unknown };
    document?: unknown;
  };
  const w = globals.window;
  const borrowedFrame = !!w && typeof w.requestAnimationFrame !== "function";
  if (borrowedFrame)
    w.requestAnimationFrame = (cb: (t: number) => void): number => {
      queueMicrotask(() => cb(performance.now()));
      return 0;
    };
  const hadDocument = "document" in globals;

  try {
    const mod = await import("@likecoin/epub-ts/node");
    return (cached = mod.Book as unknown as BookClass);
  } finally {
    if (borrowedFrame && w) delete w.requestAnimationFrame;
    if (!hadDocument) delete globals.document;
  }
}

/** One chapter as the file contained it, before anything has judged it. */
export interface ParsedChapter {
  /** the TOC label where there is one, else the document's own heading, else its filename */
  title: string;
  /** the chapter's prose, blocks separated by blank lines, with `*italic*` and `**bold**` marked */
  text: string;
  /** counted on the prose without its markers, which is what anyone would call the length */
  words: number;
  /** the section's href inside the EPUB, with the anchor when one file holds several chapters */
  href: string;
  /**
   * The file held this chapter and could not be read: a missing asset, or markup that would not
   * parse. Set so the review can say so, because an empty chapter and a lost one look identical
   * once the text is gone.
   */
  unreadable?: true;
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string;
  chapters: ParsedChapter[];
}

export class EpubParseError extends Error {
  override readonly name = "EpubParseError";
}

/**
 * A path inside the EPUB, with `.` and `..` resolved, relative to `from`.
 *
 * The two halves of a package do not agree on what a path is relative to. A spine item's `href` is
 * written against the package document; a navigation entry's is written against the navigation
 * document, which may sit in a directory of its own — `../text/c1.xhtml` and `text/c1.xhtml` are
 * then the same file spelled two ways, and comparing them as written silently loses every label.
 */
function resolve(href: string, from = ""): string {
  const raw = (href ?? "").trim();
  // A link out of the book is not a chapter of it.
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  const out: string[] = [];
  for (const part of (raw.startsWith("/") ? raw.slice(1) : from + raw).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** The directory a document lives in, as a prefix other paths resolve against. */
const dirOf = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at + 1);
};

/** One place the table of contents points at. */
interface TocEntry {
  /** the document, package-relative */
  doc: string;
  /** the element id inside it, or "" when the entry names the whole document */
  frag: string;
  label: string;
  /** how deeply nested the entry is; 0 is the top level of the table of contents */
  depth: number;
  /**
   * This entry is a heading over the chapters below it rather than one of them: it names the whole
   * document, and the navigation points *inside* that same document underneath it. "Volume One",
   * with Chapters One and Two nested under it, is the shape.
   */
  container: boolean;
}

interface TocItem {
  href?: string;
  label?: string;
  subitems?: unknown;
}

/** Every navigation entry, nesting flattened but remembered, in the order a reader meets them. */
function tocEntries(toc: readonly TocItem[], navDir: string): TocEntry[] {
  const out: TocEntry[] = [];
  const visit = (items: readonly TocItem[], depth: number): void => {
    for (const item of items) {
      const path = resolve(item.href ?? "", navDir);
      const label = (item.label ?? "").trim();
      const [doc, frag = ""] = path.split("#");
      const entry =
        doc && label ? ({ doc, frag, label, depth, container: false } as TocEntry) : null;
      if (entry) out.push(entry);
      const kids = item.subitems;
      if (!Array.isArray(kids) || !kids.length) continue;
      const below = out.length;
      visit(kids as TocItem[], depth + 1);
      // An entry that names a whole document and has the navigation pointing at places inside that
      // same document beneath it is the volume title over its chapters, not a chapter.
      if (entry && !entry.frag)
        entry.container = out.slice(below).some((k) => k.doc === entry.doc && !!k.frag);
    }
  };
  visit(toc, 0);
  return out;
}

/**
 * Where the navigation says this document's chapters begin.
 *
 * Only the shallowest level that reaches the document is read. A serial that lists twenty chapters
 * of one file side by side has them all at the top level, and each is a chapter; a novel that lists
 * scenes underneath a chapter has the chapter above them, and the scenes are not chapters. Reading
 * the deepest level instead would turn the second book into a hundred one-page chapters, and there
 * is no way back from that once the audiobook is built.
 *
 * A container is not one of those levels. It names the file its chapters are in and nothing
 * narrower, so taking it as the boundary is taking the whole file as one chapter — which is how a
 * volume listed above Chapters One and Two used to import with both of them inside it, and a notice
 * bundled in with them could not be skipped without taking the story either side of it too.
 */
function boundariesIn(entries: readonly TocEntry[], doc: string): TocEntry[] {
  const mine = entries.filter((e) => e.doc === doc && !e.container);
  if (!mine.length) return [];
  const level = Math.min(...mine.map((e) => e.depth));
  return mine.filter((e) => e.depth === level);
}

/** The document's own heading, for a section the TOC does not name. */
function headingOf(text: string): string {
  const first = text.split("\n\n", 1)[0]?.trim() ?? "";
  // A heading is a short line, not the opening sentence of the chapter under it.
  return first.length > 0 && first.length <= 80 && !/[.!?]$/.test(first) ? first : "";
}

/** A last-resort title from the filename: `chapter-012.xhtml` → `Chapter 012`. */
function titleFromHref(href: string): string {
  const base =
    href
      .split("#")[0]
      .split("/")
      .pop()
      ?.replace(/\.x?html?$/i, "") ?? "";
  const words = base.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Untitled";
}

/**
 * Cut one rendered section into the chapters the navigation says it holds.
 *
 * A single file holding several chapters is how most web-novel EPUBs are packed, and treating it
 * as one chapter is not a cosmetic loss: a notice bundled in with two chapters cannot be skipped
 * without taking the story either side of it with it.
 *
 * An anchor the file does not actually contain produces no chapter. Its text is not lost — it stays
 * with the chapter before it — which is the safe direction to be wrong in.
 */
async function chaptersIn(
  html: string,
  doc: string,
  bounds: readonly TocEntry[],
): Promise<ParsedChapter[]> {
  const labelled = new Map(bounds.filter((b) => b.frag).map((b) => [b.frag, b.label]));
  const parts = await sectionParts(html, [...labelled.keys()]);

  // Text before the first anchor that no entry claims is the file's own front matter — a series
  // title above the first chapter. It reads as the opening of the chapter that follows it.
  const lead = parts[0];
  const leadLabel = bounds.length && !bounds[0].frag ? bounds[0].label : null;
  if (parts.length > 1 && leadLabel == null) {
    parts.shift();
    if (lead.text) parts[0].text = [lead.text, parts[0].text].filter(Boolean).join("\n\n");
  }

  return parts.map((part) => {
    const label = part.id ? labelled.get(part.id) : leadLabel;
    const href = part.id ? `${doc}#${part.id}` : doc;
    // Counted and titled from the prose, not from the markers in it: `*The Ledger Opens*` is a
    // heading with two stars in it to anybody reading the page.
    const prose = plainText(part.text);
    return {
      title: label || headingOf(prose) || titleFromHref(href),
      text: part.text,
      words: countWords(prose),
      href,
    };
  });
}

/** The one private method this has to reach for, named rather than cast at the call site. */
interface WithNavigationLoader {
  loadNavigation(packaging: unknown): Promise<unknown>;
  navigation?: unknown;
}

/**
 * Keep a table of contents that is not there from bringing the process down with it.
 *
 * `unpack` calls `loadNavigation(…).then(…)` with no catch, and the `Promise.all` that settles
 * `opened` has none either. An EPUB that declares a navigation document it does not contain
 * therefore produces two rejections nothing outside the library holds a handle to: the book opens,
 * every chapter is present and readable, and the process takes an unhandled rejection that is fatal
 * under Node's `--unhandled-rejections=throw`. Losing nine hundred chapters that are all there
 * because the contents page is missing is the wrong way round.
 *
 * Settling it as "no navigation" is the library's own behaviour for a book that declares none, so
 * the outcome is the documented one: the chapters keep their own headings for titles. Shadowed on
 * the instance rather than patched onto the prototype, so it affects this parse and nothing else.
 */
function survivableNavigation(book: Book): void {
  const b = book as unknown as WithNavigationLoader;
  if (typeof b.loadNavigation !== "function") return;
  const load = b.loadNavigation.bind(b);
  b.loadNavigation = (packaging) => load(packaging).catch(() => b.navigation);
}

type Archive = NonNullable<Book["archive"]>;

/**
 * The archive's own request for a section, with its HTML entities made ones XML knows.
 *
 * The same two steps the library's `request` takes — the file's text, then parsed by its
 * extension — with `numericEntities` between them, because after the parse is too late: an
 * `&nbsp;` the XML parser did not know is text by then, indistinguishable from a book that wrote
 * the word. A file the archive does not have goes through the library's own request, so it fails
 * the way it always did.
 */
function readSection(archive: Archive) {
  return async (url: string, type?: string): Promise<unknown> => {
    const text = archive.getText(url);
    if (!text) return archive.request(url, type);
    const extension = url.split(/[?#]/)[0].split("/").at(-1)?.split(".").at(-1) ?? "";
    return archive.handleResponse(numericEntities(await text), type ?? extension.toLowerCase());
  };
}

/**
 * Read an EPUB from its bytes.
 *
 * Sections are read one at a time and unloaded straight after. A web-novel volume can be a
 * thousand chapters, and holding every parsed document at once is how a routine import turns into
 * an out-of-memory crash on a machine that was never short of memory.
 */
export async function parseEpub(bytes: ArrayBuffer): Promise<ParsedEpub> {
  // Opened in two steps rather than through the documented `new Book(bytes)`, so that the promise
  // the open produces is one this function owns and awaits.
  //
  // A Book holds a deferred promise per part of the package — manifest, spine, metadata, cover,
  // navigation, and the rest — and a file that cannot be unzipped rejects all of them. Nothing
  // awaits most of them, so each becomes an unhandled rejection: three of them for a corrupt
  // upload, which under Node's default is enough to take the process down and is noise in the test
  // output either way. Settling them with a no-op handler first costs nothing on a good file and
  // turns a bad one into the single error the caller is already catching.
  const Book = await loadBookClass();
  const book = new Book();
  book.opened?.catch(() => {});
  book.ready?.catch(() => {});
  for (const part of Object.values(book.loaded ?? {}))
    (part as Promise<unknown> | undefined)?.catch?.(() => {});

  survivableNavigation(book);

  try {
    await book.open(bytes, "binary");
  } catch (cause) {
    throw new EpubParseError(
      `This file could not be opened as an EPUB. ${cause instanceof Error ? cause.message : ""}`.trim(),
    );
  }

  try {
    const meta = book.packaging?.metadata;
    if (!meta) throw new EpubParseError("The EPUB has no package metadata.");

    // `open` resolves as soon as the package document is parsed; the navigation document is a
    // second file and is still being fetched. Reading `book.navigation` here without waiting finds
    // nothing at all, and every chapter silently falls back to its own heading — which usually
    // looks close enough to be believed and is not the title the book's contents give it.
    //
    // Waited for on its own rather than through `book.ready`, which also covers the cover image and
    // the resource list: a book with no cover has a perfectly good table of contents, and losing it
    // to an unrelated failure would be the same silent fallback by another route. A book with no
    // navigation at all is legal, so this resolving empty is not an error either.
    await book.loaded?.navigation?.catch(() => undefined);

    const navDoc = resolve(book.packaging.navPath ?? "");
    const entries = tocEntries((book.navigation?.toc ?? []) as TocItem[], dirOf(navDoc));
    const chapters: ParsedChapter[] = [];
    let readable = 0;
    let sections = 0;

    for (const section of book.spine.spineItems) {
      const doc = resolve(section.href ?? "");
      // The navigation document is the table of contents itself, and a non-linear section is
      // supplementary by the spec's own definition — a cover plate, a colophon. Neither is a
      // chapter, and both would otherwise arrive in the review as one to decide on.
      if (!doc || doc === navDoc) continue;
      if (section.linear === false) continue;
      sections++;

      let html: string | null = null;
      try {
        html = await section.render(readSection(book.archive!));
      } catch {
        // One unreadable section is not a reason to lose the other nine hundred. It arrives as a
        // chapter that says it could not be read, so the review can decide what to do about it
        // rather than being shown a chapter that merely looks short.
        html = null;
      } finally {
        section.unload();
      }

      const bounds = boundariesIn(entries, doc);
      if (html == null) {
        // One entry for each chapter the navigation says was in the file, not one for the file. A
        // damaged file holding three chapters is three chapters to answer for; reporting it as one
        // leaves the other two missing from a review that never mentions them — and the numbering
        // of everything after them quietly shifts.
        for (const bound of bounds.length ? bounds : [null])
          chapters.push({
            title: bound?.label || titleFromHref(doc),
            text: "",
            words: 0,
            href: bound?.frag ? `${doc}#${bound.frag}` : doc,
            unreadable: true,
          });
        continue;
      }
      readable++;
      chapters.push(...(await chaptersIn(html, doc, bounds)));
    }

    if (!chapters.length)
      throw new EpubParseError("The EPUB has no readable chapters in its spine.");
    // Every section in the spine failed to render. The file is an EPUB and its package parsed, so
    // it opened — but there is no book in it, and importing one chapter of nothing per file would
    // put an empty shelf entry in the library and call it a success.
    if (sections && !readable)
      throw new EpubParseError(
        `None of the ${sections} section${sections === 1 ? "" : "s"} in this EPUB could be read. Its chapter files are missing or damaged.`,
      );

    return {
      title: (meta.title ?? "").trim() || "Untitled",
      author: (meta.creator ?? "").trim() || "Unknown",
      language: (meta.language ?? "").trim(),
      chapters,
    };
  } finally {
    book.destroy();
  }
}
