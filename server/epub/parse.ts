// Reads a real EPUB: title, author, and chapters in reading order with their text. Which chapters
// are story is `server/epub/notices.ts`; building the book is `server/import/assemble.ts`.
// Uses @likecoin/epub-ts's `/node` entry, which registers linkedom's DOMParser itself; sections
// render through the archive, so nothing reaches the network.
import type { Book } from "@likecoin/epub-ts/node";

import { numericEntities } from "~/epub/entities";
import { plainText } from "~/epub/markdown";
import { countWords, sectionParts } from "~/epub/text";

type BookClass = new (options?: { replacements?: "none" | "blobUrl" | "base64" }) => Book;
let cached: BookClass | null = null;

/**
 * Load the EPUB library with its import-time side effects contained. The bundle calls
 * `window.requestAnimationFrame` on any `window` (throws under a test's `window` stub), and it
 * installs a global `document` that makes server code take DOM paths. Both are undone here.
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
  /** blocks separated by blank lines, with `*italic*` and `**bold**` marked */
  text: string;
  /** counted on the prose without its markers */
  words: number;
  /** the section's href inside the EPUB, with the anchor when one file holds several chapters */
  href: string;
  /** The file held this chapter and could not be read; an empty and a lost chapter look alike. */
  unreadable?: true;
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string;
  chapters: ParsedChapter[];
  /** The package's cover image bytes, unchecked. Absent when none is named or the zip lacks it. */
  cover?: Uint8Array;
}

export class EpubParseError extends Error {
  override readonly name = "EpubParseError";
}

/**
 * An href as its filename is spelled (`Chapter%201.xhtml` → `Chapter 1.xhtml`). Nav and manifest
 * are often written by tools that encode differently. A `%` that is not an escape is kept.
 */
function decoded(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * A path inside the EPUB, with `.` and `..` resolved, relative to `from`. Spine hrefs are relative
 * to the package document, nav hrefs to the nav document, which may sit in another directory.
 */
function resolve(href: string, from = ""): string {
  const raw = (href ?? "").trim();
  // A link out of the book, `//host/x.html` included, is not a chapter.
  if (!raw || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  const hash = raw.indexOf("#");
  const path = hash < 0 ? raw : raw.slice(0, hash);
  const frag = hash < 0 ? "" : decoded(raw.slice(hash + 1));
  const out: string[] = [];
  for (const part of (path.startsWith("/") ? path.slice(1) : from + path).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(decoded(part));
  }
  return out.join("/") + (hash < 0 ? "" : `#${frag}`);
}

/**
 * Whether a package-relative href climbs above the zip's root. `resolve` silently drops such a
 * `..`, but `../../extras.xhtml` names a file beside the EPUB, not a chapter in it.
 */
function leavesArchive(href: string, packageDir: string): boolean {
  let depth = 0;
  for (const part of (packageDir + href.split("#")[0]).split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") depth++;
    else if (--depth < 0) return true;
  }
  return false;
}

const dirOf = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at + 1);
};

/** One place the table of contents points at. */
interface TocEntry {
  /** package-relative */
  doc: string;
  /** the element id inside it, or "" when the entry names the whole document */
  frag: string;
  label: string;
  /** 0 is the top level */
  depth: number;
  /** A heading over the chapters nested under it ("Volume One"): it names the whole document and
   * the nav points inside that document beneath it. */
  container: boolean;
}

interface TocItem {
  href?: string;
  label?: string;
  subitems?: unknown;
}

/** Every navigation entry, nesting flattened but remembered, in reading order. */
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
      if (entry && !entry.frag)
        entry.container = out.slice(below).some((k) => k.doc === entry.doc && !!k.frag);
    }
  };
  visit(toc, 0);
  return out;
}

/**
 * Where the nav says this document's chapters begin: only the shallowest level that reaches it,
 * so scenes nested under a chapter don't become chapters. Containers are skipped, or a volume
 * heading would make the whole file one chapter.
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
 * Cut one rendered section into the chapters the nav says it holds (web novels pack many per file).
 * An anchor the file lacks produces no chapter; its text stays with the chapter before it.
 */
async function chaptersIn(
  html: string,
  doc: string,
  bounds: readonly TocEntry[],
): Promise<ParsedChapter[]> {
  const labelled = new Map(bounds.filter((b) => b.frag).map((b) => [b.frag, b.label]));
  const parts = await sectionParts(html, [...labelled.keys()]);

  // Unclaimed text before the first anchor (a series title) joins the chapter after it.
  const lead = parts[0];
  const leadLabel = bounds.length && !bounds[0].frag ? bounds[0].label : null;
  if (parts.length > 1 && leadLabel == null) {
    parts.shift();
    if (lead.text) parts[0].text = [lead.text, parts[0].text].filter(Boolean).join("\n\n");
  }

  return parts.map((part) => {
    const label = part.id ? labelled.get(part.id) : leadLabel;
    const href = part.id ? `${doc}#${part.id}` : doc;
    // Titled and counted from the prose, not the `*` markers in it.
    const prose = plainText(part.text);
    return {
      title: label || headingOf(prose) || titleFromHref(href),
      text: part.text,
      words: countWords(prose),
      href,
    };
  });
}

/** The one private method this has to reach for. */
interface WithNavigationLoader {
  loadNavigation(packaging: unknown): Promise<unknown>;
  navigation?: unknown;
}

/**
 * A missing nav document makes `unpack`'s uncaught `loadNavigation` reject, which is fatal under
 * `--unhandled-rejections=throw`. Settle it as "no navigation", the library's own behaviour for a
 * book that declares none. Shadowed on the instance, so only this parse is affected.
 */
function survivableNavigation(book: Book): void {
  const b = book as unknown as WithNavigationLoader;
  if (typeof b.loadNavigation !== "function") return;
  const load = b.loadNavigation.bind(b);
  b.loadNavigation = (packaging) => load(packaging).catch(() => b.navigation);
}

type Archive = NonNullable<Book["archive"]>;

/**
 * The library's `request` for a section (text, then parse by extension) with `numericEntities`
 * in between: after the XML parse an unknown `&nbsp;` is already literal text. Missing files go
 * through the library's own request so they fail as before.
 */
function readSection(archive: Archive) {
  return async (url: string, type?: string): Promise<unknown> => {
    const text = archive.getText(url);
    if (!text) return archive.request(url, type);
    const extension = url.split(/[?#]/)[0].split("/").at(-1)?.split(".").at(-1) ?? "";
    return archive.handleResponse(numericEntities(await text), type ?? extension.toLowerCase());
  };
}

/** The cover image's bytes, when the package names one. An unreadable cover is no cover. */
async function coverOf(book: InstanceType<BookClass>): Promise<Uint8Array | undefined> {
  const href = book.packaging?.coverPath;
  if (!href || !book.archive) return undefined;
  try {
    const path = book.resolve(href);
    // A manifest href is a URL and the archive is keyed by filename; see `decoded`.
    const blob = (await book.archive.getBlob(path)) ?? (await book.archive.getBlob(decoded(path)));
    return blob?.size ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read an EPUB from its bytes. Sections are read one at a time and unloaded straight after, so a
 * thousand-chapter volume does not run out of memory.
 */
export async function parseEpub(bytes: ArrayBuffer): Promise<ParsedEpub> {
  // Not `new Book(bytes)`: a corrupt file rejects every deferred part promise, each unhandled and
  // fatal. Opening in two steps lets us silence those first and await the one error here.
  const Book = await loadBookClass();
  // No replacements: blob URLs are unused here, and a missing asset gets `console.error`ed.
  const book = new Book({ replacements: "none" });
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

  // Display-only hooks that throw and `console.error` on a section with no `<head>`.
  book.spine?.hooks?.content?.clear();

  try {
    const meta = book.packaging?.metadata;
    if (!meta) throw new EpubParseError("The EPUB has no package metadata.");

    // `open` resolves before the nav document loads. Awaited alone, not via `book.ready`, so a
    // failing cover can't cost the TOC. No navigation at all is legal.
    await book.loaded?.navigation?.catch(() => undefined);

    const navDoc = resolve(book.packaging.navPath ?? "");
    const packageDir = dirOf(resolve(book.container?.packagePath ?? ""));
    const entries = tocEntries((book.navigation?.toc ?? []) as TocItem[], dirOf(navDoc));
    const chapters: ParsedChapter[] = [];
    let readable = 0;
    let sections = 0;

    for (const section of book.spine.spineItems) {
      const doc = resolve(section.href ?? "");
      // The nav document and non-linear sections (cover plate, colophon) are not chapters.
      if (!doc || doc === navDoc || leavesArchive(section.href ?? "", packageDir)) continue;
      if (section.linear === false) continue;
      sections++;

      let html: string | null = null;
      try {
        html = await section.render(readSection(book.archive!));
      } catch {
        // Arrives as an unreadable chapter for the review to decide on.
        html = null;
      } finally {
        section.unload();
      }

      const bounds = boundariesIn(entries, doc);
      if (html == null) {
        // One entry per chapter the nav puts in the file, so later numbering doesn't shift.
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
    // Every section failed to render: no book in it, so not a successful import.
    if (sections && !readable)
      throw new EpubParseError(
        `None of the ${sections} section${sections === 1 ? "" : "s"} in this EPUB could be read. Its chapter files are missing or damaged.`,
      );

    const cover = await coverOf(book);
    return {
      title: (meta.title ?? "").trim() || "Untitled",
      author: (meta.creator ?? "").trim() || "Unknown",
      language: (meta.language ?? "").trim(),
      chapters,
      ...(cover ? { cover } : {}),
    };
  } finally {
    book.destroy();
  }
}
