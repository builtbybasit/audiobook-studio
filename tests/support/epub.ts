// Building an EPUB to import.
//
// The server's import is the one part of the app that reads a real file, so its tests need real
// files. These are assembled in memory — a valid EPUB 3 package with a navigation document, a
// spine and the chapters asked for — which keeps the suite free of binary fixtures that nobody
// can read a diff of.
//
// What can be varied here is what real EPUBs actually vary: where the navigation document sits
// relative to the chapters, whether it names a chapter something other than the heading inside it,
// whether one file holds several chapters, and whether a file the package promises is there at all.
import JSZip from "jszip";

/** One chapter inside a file that holds more than one, anchored where the navigation points. */
export interface SectionInput {
  /** the element id the navigation entry links to */
  id: string;
  /** the label in the navigation */
  title: string;
  /** the heading in the markup, when it differs from the navigation's label */
  heading?: string;
  paragraphs: string[];
  /**
   * Anchor it the way older books do, `<a name="…">`, with an unrelated `id` beside it as a
   * converter leaves one, rather than an `id` on the section.
   */
  byName?: true;
}

export interface ChapterInput {
  title: string;
  /** paragraphs; each becomes its own <p> */
  paragraphs?: string[];
  /** body markup, in place of `paragraphs`, for the cases that are about the markup itself */
  raw?: string;
  /** the navigation's label, when the file's own heading says something else */
  navTitle?: string;
  /** leave this chapter out of the navigation document, so its title comes from the markup */
  untitled?: boolean;
  /** mark the spine item non-linear: supplementary matter, not a chapter */
  nonLinear?: boolean;
  /** several chapters in this one file, each with a navigation anchor of its own */
  sections?: SectionInput[];
  /** in the manifest and the spine, but not in the zip: a file the package promises and lacks */
  missing?: true;
  /** write the file with no `<head>`, as some converters do */
  headless?: true;
  /** the file's name in the zip, in place of `cN.xhtml` — `Chapter 1.xhtml`, say */
  file?: string;
  /** how the manifest spells the file, when it is not as written — `Chapter%201.xhtml` */
  manifestHref?: string;
  /** how the navigation spells the file, when it is not as written */
  navHref?: string;
}

export interface EpubInput {
  title?: string;
  author?: string;
  chapters: ChapterInput[];
  /**
   * Put the navigation document in a directory of its own, and the chapters in another, so its
   * links have to be resolved against it — `../text/c1.xhtml`, not `text/c1.xhtml`.
   */
  navDir?: string;
  /** nest every navigation entry under one top-level entry, the way a volume list does */
  nestUnder?: string;
  /**
   * Give that nesting entry a link of its own, to the file its children are in — a volume title
   * page listed above the chapters that follow it in the same file.
   */
  nestLinked?: true;
  /** promise a navigation document in the manifest and leave it out of the archive */
  missingNav?: true;
  /** further spine items, by href as the manifest writes them — links out of the book, say */
  extraSpine?: string[];
  /** further manifest items that are not documents, by href: an image the zip may not have */
  assets?: string[];
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A fixed last-modified date, which EPUB 3 requires and which a fixture must not take from the
 * clock: two builds of the same input have to be the same bytes, or a test that compares them
 * fails once a second.
 */
const MODIFIED = "2026-01-01T00:00:00Z";

/**
 * A real UUID, derived from the book so it is stable across builds.
 *
 * `urn:uuid:test-3` is not one, and EPUBCheck says so. The fixtures are the only EPUBs this suite
 * ever sees, so a fixture that is quietly invalid is a blind spot exactly where the code under test
 * is supposed to be strict.
 */
function uuid(seed: string, n: number): string {
  let h = 0x811c9dc5;
  for (const c of `${seed}:${n}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const hex = (i: number): string =>
    Math.imul(h ^ (i + 1), 0x01000193)
      .toString(16)
      .padStart(8, "0")
      .slice(-8);
  const all = `${hex(0)}${hex(1)}${hex(2)}${hex(3)}${hex(4)}`;
  // 8-4-4-4-12, with the version and variant nibbles EPUBCheck checks for
  return `${all.slice(0, 8)}-${all.slice(8, 12)}-4${all.slice(13, 16)}-a${all.slice(17, 20)}-${all.slice(20, 32)}`;
}

const para = (ps: string[]): string => ps.map((p) => `<p>${esc(p)}</p>`).join("\n");

function bodyOf(c: ChapterInput): string {
  if (c.raw) return c.raw;
  if (c.sections)
    return c.sections
      .map((s) =>
        s.byName
          ? `<section><h2><a name="${s.id}" id="calibre_${s.id}"></a>${esc(s.heading ?? s.title)}</h2>\n${para(s.paragraphs)}</section>`
          : `<section id="${s.id}"><h2>${esc(s.heading ?? s.title)}</h2>\n${para(s.paragraphs)}</section>`,
      )
      .join("\n");
  return `<h1>${esc(c.title)}</h1>\n${para(c.paragraphs ?? [])}`;
}

const xhtml = (title: string, body: string, headless = false): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">${headless ? "" : `<head><title>${esc(title)}</title></head>`}
<body>${body}
</body></html>`;

/** A valid EPUB 3 file, as the bytes an upload would carry. */
export async function buildEpub({
  title = "The Villain Pays in Full",
  author = "A. Ledger",
  chapters,
  navDir,
  nestUnder,
  nestLinked,
  missingNav,
  extraSpine = [],
  assets = [],
}: EpubInput): Promise<ArrayBuffer> {
  // With a navigation directory the chapters move too, so the two are genuinely relative to each
  // other rather than both sitting in the package root where every spelling happens to work.
  const textDir = navDir ? "text/" : "";
  const navPath = navDir ? `${navDir}/nav.xhtml` : "nav.xhtml";
  const up = navDir ? "../" : "";
  const files = chapters.map((c, i) => ({
    ...c,
    file: `${textDir}${c.file ?? `c${i + 1}.xhtml`}`,
    manifestHref: `${textDir}${c.manifestHref ?? c.file ?? `c${i + 1}.xhtml`}`,
    navHref: `${textDir}${c.navHref ?? c.file ?? `c${i + 1}.xhtml`}`,
    id: `c${i + 1}`,
  }));

  /** The navigation entries for one chapter file: one per anchor, or one for the file. */
  const links = (f: (typeof files)[number]): string[] =>
    f.sections
      ? f.sections.map((s) => `<a href="${up}${f.navHref}#${s.id}">${esc(s.title)}</a>`)
      : [`<a href="${up}${f.navHref}">${esc(f.navTitle ?? f.title)}</a>`];

  const items = files
    .filter((f) => !f.untitled)
    .flatMap(links)
    .map((a) => `<li>${a}</li>`)
    .join("\n");
  const nestLabel = nestLinked
    ? `<a href="${up}${files[0].navHref}">${esc(nestUnder ?? "")}</a>`
    : `<span>${esc(nestUnder ?? "")}</span>`;
  const toc = nestUnder ? `<li>${nestLabel}<ol>\n${items}\n</ol></li>` : items;

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:uuid:${uuid(title, files.length)}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:creator>${esc(author)}</dc:creator>
<dc:language>en</dc:language>
<meta property="dcterms:modified">${MODIFIED}</meta>
</metadata>
<manifest>
<item id="nav" href="${navPath}" media-type="application/xhtml+xml" properties="nav"/>
${files.map((f) => `<item id="${f.id}" href="${f.manifestHref}" media-type="application/xhtml+xml"/>`).join("\n")}
${extraSpine.map((href, i) => `<item id="x${i + 1}" href="${esc(href)}" media-type="application/xhtml+xml"/>`).join("\n")}
${assets.map((href, i) => `<item id="a${i + 1}" href="${esc(href)}" media-type="image/png"/>`).join("\n")}
</manifest>
<spine>
${files.map((f) => `<itemref idref="${f.id}"${f.nonLinear ? ' linear="no"' : ""}/>`).join("\n")}
${extraSpine.map((_, i) => `<itemref idref="x${i + 1}"/>`).join("\n")}
</spine>
</package>`,
  );
  if (!missingNav)
    zip.file(
      `OEBPS/${navPath}`,
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
${toc}
</ol></nav></body></html>`,
    );
  // A missing file is written nowhere: the manifest and the spine both promise it, and the archive
  // does not have it, which is what a damaged or incompletely downloaded EPUB looks like.
  for (const f of files)
    if (!f.missing) zip.file(`OEBPS/${f.file}`, xhtml(f.title, bodyOf(f), f.headless));
  return zip.generateAsync({ type: "arraybuffer" });
}

/** An EPUB as an upload: what a `multipart/form-data` request would carry. */
export async function epubFile(input: EpubInput, name = "book.epub"): Promise<File> {
  return new File([await buildEpub(input)], name, { type: "application/epub+zip" });
}

/** Enough sentences to read as a full chapter rather than a short notice. */
export const story = (n = 24): string[] =>
  Array.from(
    { length: n },
    (_, i) =>
      `“We settle the account tonight,” said Aurelie, and the clerk wrote the ${i + 1}th line without looking up from the ledger he had been keeping since the spring.`,
  );
