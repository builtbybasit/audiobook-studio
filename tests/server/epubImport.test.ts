// Reading an actual EPUB into a book. The prototype never parsed a file; everything here is the
// part that was missing, so the cases are about what real files contain rather than what the
// samples declared.
import { describe, expect, spyOn, test } from "bun:test";

import { EpubCheck } from "@likecoin/epubcheck-ts";
import { eq } from "drizzle-orm";

import type { Book, Chapter } from "@/types";
import { chapterTexts } from "~/db/schema";
import { numericEntities } from "~/epub/entities";
import { parseEmphasis, plainText } from "~/epub/markdown";
import { countWords, sectionParts, sectionText } from "~/epub/text";
import { buildEpub, epubFile, story } from "../support/epub";
import { testApi } from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
}

describe("the EPUBs these tests are built on", () => {
  // The fixtures are the only EPUBs this suite ever sees. One that is quietly invalid is a blind
  // spot exactly where the code under test is meant to be strict — and this caught two, an
  // identifier that was not a UUID and a missing `dcterms:modified`, which EPUB 3 requires.
  const shapes: [string, Parameters<typeof buildEpub>[0]][] = [
    ["a plain book", { chapters: [{ title: "One", paragraphs: story() }] }],
    [
      "a navigation document in its own directory",
      {
        navDir: "front",
        chapters: [
          { title: "One", paragraphs: story() },
          { title: "Two", paragraphs: story() },
        ],
      },
    ],
    [
      "several chapters in one file",
      {
        chapters: [
          {
            title: "Part",
            sections: [
              { id: "a", title: "One", paragraphs: story() },
              { id: "b", title: "Two", paragraphs: story() },
            ],
          },
        ],
      },
    ],
    [
      "a nested navigation",
      { nestUnder: "Volume One", chapters: [{ title: "One", paragraphs: story() }] },
    ],
    [
      "a non-linear item and one the navigation skips",
      {
        chapters: [
          { title: "Cover", paragraphs: ["A plate."], nonLinear: true },
          { title: "One", paragraphs: story(), untitled: true },
        ],
      },
    ],
    [
      "markup given raw",
      { chapters: [{ title: "T", raw: "<h1>T</h1><table><tr><td>a</td></tr></table>" }] },
    ],
  ];

  test.each(shapes)("%s is a valid EPUB 3", async (_name, input) => {
    const result = await EpubCheck.validate(new Uint8Array(await buildEpub(input)));
    expect(result.messages.map((m) => `${m.severity} ${m.id}`)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("the same input twice is the same bytes", async () => {
    const input = { chapters: [{ title: "One", paragraphs: story() }] };
    // the modified date and the identifier come from the book, never from the clock
    const a = new Uint8Array(await buildEpub(input));
    const b = new Uint8Array(await buildEpub(input));
    expect(a).toEqual(b);
  });

  test("a deliberately damaged fixture is still damaged", async () => {
    const result = await EpubCheck.validate(
      new Uint8Array(
        await buildEpub({
          chapters: [
            { title: "One", paragraphs: story() },
            { title: "Two", missing: true },
          ],
        }),
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.messages.some((m) => m.id === "RSC-001")).toBe(true);
  });
});

describe("importing an EPUB", () => {
  test("reads the book's own metadata and numbers its chapters from one", async () => {
    const api = testApi();
    const { status, body } = await api.import<ImportResult>(
      await epubFile({
        title: "Moonlight Ledger",
        author: "Wen Jia",
        chapters: [
          { title: "The Ledger Opens", paragraphs: story() },
          { title: "Salt Tax", paragraphs: story() },
          { title: "Arrears", paragraphs: story() },
        ],
      }),
    );

    expect(status).toBe(201);
    expect(body.book.title).toBe("Moonlight Ledger");
    expect(body.book.author).toBe("Wen Jia");
    expect(body.chapters.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax", "Arrears"]);
    // the volume covers exactly the chapters it brought
    expect(body.book.volumes[0].from).toBe(1);
    expect(body.book.volumes[0].to).toBe(3);
    // an imported book waits in its review rather than joining the library
    expect(body.book.importing).toBe(true);
    expect(body.book.volumes[0].importing).toBe(true);
  });

  test("a chapter the navigation does not name is titled by its own heading", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          { title: "The Ledger Opens", paragraphs: story() },
          { title: "An Honest Forgery", paragraphs: story(), untitled: true },
        ],
      }),
    );
    expect(body.chapters[1].title).toBe("An Honest Forgery");
  });

  test("the navigation document and non-linear matter are not chapters", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          { title: "Cover", paragraphs: ["A plate."], nonLinear: true },
          { title: "The Ledger Opens", paragraphs: story() },
        ],
      }),
    );
    // the nav document is in the manifest and the cover plate is in the spine; neither is story
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens"]);
  });

  test("a title given by the importer wins over the one in the file", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        title: "Untitled Draft",
        chapters: [{ title: "One", paragraphs: story() }],
      }),
      { title: "The Villain Pays in Full" },
    );
    expect(body.book.title).toBe("The Villain Pays in Full");
    expect(body.book.id).toBe("the-villain-pays-in-full");
  });

  test("a second book of the same name gets an id of its own", async () => {
    const api = testApi();
    const file = () =>
      epubFile({ title: "Salt", chapters: [{ title: "One", paragraphs: story() }] });
    const first = await api.import<ImportResult>(await file());
    const second = await api.import<ImportResult>(await file());
    expect(first.body.book.id).toBe("salt");
    expect(second.body.book.id).toBe("salt-2");
  });

  test("a file that is not an EPUB is refused, and says what is wrong with it", async () => {
    const api = testApi();
    const { status, body } = await api.import<{ error: { message: string; detail: string } }>(
      new File(["this is not a zip"], "notes.epub", { type: "application/epub+zip" }),
    );
    expect(status).toBe(415);
    expect(body.error.message).toBe("That file could not be read as an EPUB");
    // The parser can only say what stopped it. EPUBCheck says what is wrong with the file, which
    // is the half somebody holding a broken book can actually act on.
    expect(body.error.detail).toContain("EPUBCheck");
    expect(body.error.detail).toContain("PKG-004");
  });

  test("a refusal names the resource the package promised and does not have", async () => {
    const api = testApi();
    const { status, body } = await api.import<{ error: { detail: string } }>(
      await epubFile({
        chapters: [
          { title: "One", missing: true },
          { title: "Two", missing: true },
        ],
      }),
    );
    expect(status).toBe(415);
    expect(body.error.detail).toContain("RSC-001");
    expect(body.error.detail).toContain("c1.xhtml");
  });

  test("an empty file is refused before anything tries to parse it", async () => {
    const api = testApi();
    const { status, body } = await api.import<{ error: { message: string } }>(
      new File([], "empty.epub", { type: "application/epub+zip" }),
    );
    expect(status).toBe(400);
    expect(body.error.message).toBe("That file is empty");
  });

  test("the navigation's title wins over the heading inside the file", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [{ title: "Chapter One", navTitle: "1. The Ledger Opens", paragraphs: story() }],
      }),
    );
    // The navigation is a second file and is still loading when `open` resolves. Read too early it
    // is simply absent, and every chapter silently falls back to its own heading — which looks
    // close enough to be believed and is not what the book's contents call it.
    expect(body.chapters[0].title).toBe("1. The Ledger Opens");
  });

  test("a navigation document in its own directory still names the chapters", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        navDir: "front",
        chapters: [
          { title: "Chapter One", navTitle: "The Ledger Opens", paragraphs: story() },
          { title: "Chapter Two", navTitle: "Salt Tax", paragraphs: story() },
        ],
      }),
    );
    // Its links read `../text/c1.xhtml`, the spine's read `text/c1.xhtml`: the same file, spelled
    // against two different documents. Compared as written, every label is lost.
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax"]);
  });

  test("a navigation document that is missing costs the titles, not the book", async () => {
    const api = testApi();
    const { status, body } = await api.import<ImportResult>(
      await epubFile({
        missingNav: true,
        chapters: [
          { title: "The Ledger Opens", paragraphs: story() },
          { title: "Salt Tax", paragraphs: story() },
        ],
      }),
    );
    // The navigation is awaited on its own so that losing it cannot take the import with it: the
    // chapters are all still there, titled by their own headings.
    expect(status).toBe(201);
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax"]);
  });

  test("one file holding several chapters becomes several chapters", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          {
            title: "Part One",
            sections: [
              { id: "ch1", title: "The Ledger Opens", paragraphs: story() },
              { id: "ch2", title: "Salt Tax", paragraphs: story() },
              { id: "ch3", title: "Arrears", paragraphs: story() },
            ],
          },
        ],
      }),
    );
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax", "Arrears"]);
    expect(body.chapters.map((c) => c.id)).toEqual([1, 2, 3]);
    // and each one holds only its own text
    const second = await api.request<{ text: string }>(
      `/api/books/${body.book.id}/chapters/2/text`,
    );
    expect(second.body.text).toContain("Salt Tax");
    expect(second.body.text).not.toContain("Arrears");
  });

  test("a notice packed in with two chapters can be skipped on its own", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          {
            title: "Part One",
            sections: [
              { id: "ch1", title: "The Ledger Opens", paragraphs: story() },
              {
                id: "note",
                title: "Author's note",
                paragraphs: [
                  "Thank you for reading! I am going on hiatus for two weeks — no new chapters for a while.",
                  "Support the story on my patreon if you would like to.",
                ],
              },
              { id: "ch2", title: "Salt Tax", paragraphs: story() },
            ],
          },
        ],
      }),
    );
    // One chapter per file would have made this one row: skipping the notice would take the story
    // either side of it with it, and keeping the story would keep the notice.
    expect(body.chapters).toHaveLength(3);
    expect(body.chapters[1].note?.kind).toBe("hiatus");
    expect(body.chapters[0].note).toBeUndefined();
    expect(body.chapters[2].note).toBeUndefined();

    const { body: after } = await api.request<{ chapters: Chapter[] }>(
      `/api/books/${body.book.id}/chapters/skip`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [2] }),
      },
    );
    expect(after.chapters.filter((c) => c.excluded).map((c) => c.id)).toEqual([2]);
  });

  test("a line above the first anchor opens the chapter that follows it", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          {
            title: "Part One",
            raw:
              "<p>The Moonlight Ledger</p>" +
              '<section id="ch1"><h2>The Ledger Opens</h2><p>Rain fell.</p></section>' +
              '<section id="ch2"><h2>Salt Tax</h2><p>He signed twice.</p></section>',
            sections: [
              { id: "ch1", title: "The Ledger Opens", paragraphs: [] },
              { id: "ch2", title: "Salt Tax", paragraphs: [] },
            ],
          },
        ],
      }),
    );
    // A series title above the first chapter belongs to no navigation entry. Merging it forward
    // keeps it in the book; a part of its own would be a chapter nobody named.
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax"]);
    const first = await api.request<{ text: string }>(`/api/books/${body.book.id}/chapters/1/text`);
    expect(first.body.text).toBe("The Moonlight Ledger\n\n## The Ledger Opens\n\nRain fell.");
  });

  test("scenes listed under a chapter are not chapters of their own", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        nestUnder: "Volume One",
        chapters: [
          {
            title: "Part One",
            sections: [
              { id: "ch1", title: "The Ledger Opens", paragraphs: story() },
              { id: "ch2", title: "Salt Tax", paragraphs: story() },
            ],
          },
        ],
      }),
    );
    // Both anchors sit one level down, under a volume entry that names no file. The shallowest
    // level that reaches this document is the one that decides, so they are still two chapters —
    // what must not happen is reading *every* level and turning a scene list into chapters.
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax"]);
  });

  test("a volume listed above its chapters does not swallow them", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        nestUnder: "Volume One",
        nestLinked: true,
        chapters: [
          {
            title: "Part One",
            sections: [
              { id: "ch1", title: "The Ledger Opens", paragraphs: story() },
              { id: "ch2", title: "Salt Tax", paragraphs: story() },
            ],
          },
        ],
      }),
    );
    // The volume's own entry names the file and the chapters name places inside it. Read as the
    // shallowest entry that reaches the file, it is the boundary and both chapters arrive as one —
    // where a notice packed in with them could not be skipped without the story either side of it.
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax"]);
  });

  test("a chapter laid out in a table keeps its words", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          {
            title: "The Ledger Opens",
            raw:
              "<h1>The Ledger Opens</h1>" +
              "<table><tr><td>Rain fell on the counting house, and the clerk signed twice.</td></tr></table>",
          },
        ],
      }),
    );
    // Old conversions lay prose out in a single-cell table. Losing a chapter to its layout is the
    // kind of silent emptiness the review cannot even tell you about.
    expect(body.chapters[0].words).toBeGreaterThan(8);
    const text = await api.request<{ text: string }>(`/api/books/${body.book.id}/chapters/1/text`);
    expect(text.body.text).toContain("Rain fell on the counting house");
  });

  test("a chapter the file does not contain says so, and the rest still import", async () => {
    const api = testApi();
    const { status, body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          { title: "The Ledger Opens", paragraphs: story() },
          { title: "Salt Tax", missing: true },
          { title: "Arrears", paragraphs: story() },
        ],
      }),
    );
    expect(status).toBe(201);
    expect(body.chapters).toHaveLength(3);
    const lost = body.chapters[1];
    // Not silently empty, and not silently dropped: the review is told, and asked.
    expect(lost.note?.kind).toBe("unreadable");
    expect(lost.note?.verdict).toBe("review");
    expect(lost.words).toBe(0);
    expect(body.chapters[0].note).toBeUndefined();
  });

  test("a damaged file answers for every chapter the navigation put in it", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          { title: "The Ledger Opens", paragraphs: story() },
          {
            title: "Part Two",
            missing: true,
            sections: [
              { id: "ch2", title: "Salt Tax", paragraphs: [] },
              { id: "ch3", title: "Arrears", paragraphs: [] },
            ],
          },
        ],
      }),
    );
    // One entry per file rather than per chapter hides the second one entirely: the review is
    // never told it existed, and the book is quietly a chapter short.
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax", "Arrears"]);
    expect(body.chapters.slice(1).map((c) => c.note?.kind)).toEqual(["unreadable", "unreadable"]);
  });

  test("an EPUB whose chapter files are all missing is refused, not imported empty", async () => {
    const api = testApi();
    const { status, body } = await api.import<{ error: { message: string; detail: string } }>(
      await epubFile({
        chapters: [
          { title: "One", missing: true },
          { title: "Two", missing: true },
        ],
      }),
    );
    expect(status).toBe(415);
    expect(body.error.detail).toContain("could be read");
    // and nothing was left on the shelf
    const { body: shelf } = await api.request<{ books: Book[] }>("/api/books");
    expect(shelf.books).toHaveLength(0);
  });

  test("emphasis in the file is stored in the text, as a marker", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          { title: "The Ledger Opens", raw: "<p>He said <em>never</em>, and meant it.</p>" },
        ],
      }),
    );
    // The EPUB is not kept, so import is the last moment this exists. The marker rides in the
    // string because the string is going to be edited, split and joined — an offset beside it
    // would be pointing at the wrong words after the first edit.
    const row = api.db
      .select()
      .from(chapterTexts)
      .where(eq(chapterTexts.bookId, body.book.id))
      .get();
    expect(row?.body).toBe("He said *never*, and meant it.");
    // and the length the review shows is the prose, not the markers
    expect(body.chapters[0].words).toBe(6);
  });

  test("a star the book itself contained is escaped, and comes back a star", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          { title: "Scene", raw: "<p>* * *</p><p>A 5 * 3 sum.</p><p>He said <em>never</em>.</p>" },
        ],
      }),
    );
    const row = api.db
      .select()
      .from(chapterTexts)
      .where(eq(chapterTexts.bookId, body.book.id))
      .get();
    // A scene break is three stars, not emphasised whitespace — which is what an unescaped `*`
    // would make of it the moment anything read the markers back.
    expect(row?.body).toBe("\\* \\* \\*\n\nA 5 \\* 3 sum.\n\nHe said *never*.");
    expect(plainText(row?.body ?? "")).toBe("* * *\n\nA 5 * 3 sum.\n\nHe said never.");
  });

  test("a chapter comes back as Markdown, or stripped for a model, and says which", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          {
            title: "The Ledger Opens",
            raw:
              "<h1>The Ledger Opens</h1><p>He said <em>never</em>.</p>" +
              "<table><tr><th>Day</th><th>Chapter</th></tr><tr><td>Monday</td><td>Ch 1</td></tr></table>" +
              "<p>See <a href='http://x.y/z'>the note</a>.</p>",
          },
        ],
      }),
    );
    const url = `/api/books/${body.book.id}/chapters/1/text`;

    // what the contents review renders: the chapter as the file laid it out
    const stored = await api.request<{ text: string; format: string }>(url);
    expect(stored.body.format).toBe("markdown");
    expect(stored.body.text).toContain("| Day | Chapter |");
    expect(stored.body.text).toContain("[the note](http://x.y/z)");

    // what a model or a speech provider is given: no address to be charged for, no pipes to read
    const plain = await api.request<{ text: string; format: string }>(`${url}?format=plain`);
    expect(plain.body.format).toBe("plain");
    expect(plain.body.text).toContain("Day, Chapter");
    expect(plain.body.text).toContain("See the note.");
    expect(plain.body.text).not.toContain("http://x.y/z");
    expect(plain.body.text).not.toContain("|");
    expect(plain.body.text).not.toContain("#");

    // and a format the API does not have is refused rather than guessed at
    expect((await api.request(`${url}?format=sneaky`)).status).toBe(400);
  });
});

describe("links as real EPUBs write them", () => {
  const twoInOne = (file: Record<string, string>) =>
    epubFile({
      chapters: [
        { title: "Prologue", paragraphs: story() },
        {
          title: "Two chapters",
          ...file,
          sections: [
            { id: "ch1", title: "The Ledger Opens", paragraphs: story() },
            { id: "ch2", title: "Salt Tax", paragraphs: story() },
          ],
        },
      ],
    });

  test.each([
    { manifestHref: "Chapter%201.xhtml", navHref: "Chapter 1.xhtml" },
    { manifestHref: "Chapter 1.xhtml", navHref: "Chapter%201.xhtml" },
    { manifestHref: "Chapter%201.xhtml", navHref: "Chapter%201.xhtml" },
  ])(
    "a file named with a space is found with the manifest saying $manifestHref and the navigation $navHref",
    async (spelling) => {
      const { body } = await testApi().import<ImportResult>(
        await twoInOne({ file: "Chapter 1.xhtml", ...spelling }),
      );
      // not "Chapter%201", and the second chapter not run on into the first
      expect(body.chapters.map((c) => c.title)).toEqual([
        "Prologue",
        "The Ledger Opens",
        "Salt Tax",
      ]);
    },
  );

  test("a chapter anchored by name is found though the element has an id as well", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          {
            title: "Two chapters",
            sections: [
              { id: "ch1", title: "The Ledger Opens", paragraphs: story(), byName: true },
              { id: "ch2", title: "Salt Tax", paragraphs: story(), byName: true },
            ],
          },
        ],
      }),
    );
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens", "Salt Tax"]);
    const first = await api.request<{ text: string }>(`/api/books/${body.book.id}/chapters/1/text`);
    expect(first.body.text).not.toContain("Salt Tax");
  });

  test("a spine item outside the book is not a chapter of it", async () => {
    const { body } = await testApi().import<ImportResult>(
      await epubFile({
        chapters: [{ title: "The Ledger Opens", paragraphs: story() }],
        extraSpine: [
          "https://example.com/extra.xhtml",
          "//example.com/x.xhtml",
          "../../beside.xhtml",
        ],
      }),
    );
    expect(body.chapters.map((c) => c.title)).toEqual(["The Ledger Opens"]);
  });

  test("the EPUB library writes nothing to the console, over a missing asset or a missing head", async () => {
    const errors = spyOn(console, "error");
    const warnings = spyOn(console, "warn");
    try {
      const { body } = await testApi().import<ImportResult>(
        await epubFile({
          chapters: [
            { title: "The Ledger Opens", paragraphs: story() },
            { title: "Salt Tax", paragraphs: story(), headless: true },
          ],
          assets: ["images/not-there.png"],
        }),
      );
      expect(body.chapters).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });
});

describe("extracting a section's text", () => {
  test("blocks are separated, so a heading does not run into the sentence under it", async () => {
    const text = await sectionText("<body><h1>The Ledger Opens</h1><p>Rain fell.</p></body>");
    // `textContent` would give "The Ledger OpensRain fell." — and every count downstream inherits it
    expect(text).toBe("# The Ledger Opens\n\nRain fell.");
    expect(plainText(text)).toBe("The Ledger Opens\n\nRain fell.");
  });

  test("an epigraph or a poem in a figure is kept, a picture and its caption are not", async () => {
    const text = await sectionText(
      "<body><figure class='epigraph'><blockquote><p>Hope is the thing with feathers</p></blockquote>" +
        "<figcaption>— Emily Dickinson</figcaption></figure>" +
        "<figure><img src='map.png' alt='A map'/><figcaption>Figure 1. The harbour.</figcaption></figure>" +
        "<p>Rain fell.</p></body>",
    );
    expect(text).toBe("> Hope is the thing with feathers\n\n— Emily Dickinson\n\nRain fell.");
  });

  test("markup that is not prose is left out", async () => {
    const text = await sectionText(
      "<body><nav><a href='x'>Next</a></nav><script>alert(1)</script><p>Rain fell.</p></body>",
    );
    expect(text).toBe("Rain fell.");
  });

  test("italic and bold are kept apart, and nest", async () => {
    expect(await sectionText("<body><p>He said <em>never</em>.</p></body>")).toBe(
      "He said *never*.",
    );
    expect(await sectionText("<body><p>He said <strong>never</strong>.</p></body>")).toBe(
      "He said **never**.",
    );
    // `<i>` and `<b>` are the same two instructions spelled the older way
    expect(await sectionText("<body><p><i>a</i> and <b>c</b></p></body>")).toBe("*a* and **c**");
    // and a word that is both is both, rather than two pairs of markers that cancel out
    const both = await sectionText(
      "<body><p>He said <strong><em>never</em></strong> again.</p></body>",
    );
    expect(both).toBe("He said ***never*** again.");
    const read = parseEmphasis(both);
    expect(read.emphasis.map((e) => `${e.mark}:${read.text.slice(e.at, e.to)}`)).toEqual([
      "em:never",
      "strong:never",
    ]);
  });

  test("a mark that only covers part of another keeps both spans", async () => {
    const text = await sectionText("<body><p><strong>a <em>b</em> c</strong> d</p></body>");
    expect(text).toBe("**a *b* c** d");
    const read = parseEmphasis(text);
    expect(read.emphasis.map((e) => `${e.mark}:${read.text.slice(e.at, e.to)}`)).toEqual([
      "strong:a b c",
      "em:b",
    ]);
  });

  test("a table is kept as a table, and read out a row at a time", async () => {
    const text = await sectionText(
      "<body><table><tr><th>Day</th><th>Chapter</th></tr>" +
        "<tr><td>Monday</td><td>Ch 1</td></tr></table></body>",
    );
    // Dropping the element took everything in it: a character list, a release timetable, or a
    // paragraph an old conversion laid out in cells.
    expect(text).toBe("| Day | Chapter |\n| --- | --- |\n| Monday | Ch 1 |");
    // and what a narrator would be given is the rows, never the pipes or the rule under them
    expect(plainText(text)).toBe("Day, Chapter\n\nMonday, Ch 1");
  });

  test("a link is read for what it says, not for where it points", async () => {
    const text = await sectionText("<body><p>See <a href='http://x.y/z'>the note</a>.</p></body>");
    expect(text).toBe("See [the note](http://x.y/z).");
    // a URL spoken aloud is a minute of narrated punctuation, and billed by the character
    expect(plainText(text)).toBe("See the note.");
  });

  test("a section splits at the anchors the navigation points at", async () => {
    const parts = await sectionParts(
      '<body><p>A series.</p><section id="a"><h2>One</h2><p>Alpha.</p></section>' +
        '<section id="b"><h2>Two</h2><p>Beta.</p></section></body>',
      ["a", "b"],
    );
    // The text above the first anchor is reported as its own part rather than folded into one:
    // "the file had nothing there" and "the file had a series title there" are different, and the
    // import is what decides which chapter that line belongs to.
    expect(parts.map((p) => p.id)).toEqual([null, "a", "b"]);
    expect(parts.map((p) => p.text)).toEqual(["A series.", "## One\n\nAlpha.", "## Two\n\nBeta."]);
  });

  test("splitting keeps the markup of what it cuts", async () => {
    const parts = await sectionParts(
      '<body><section id="a"><ul><li>Monday</li><li>Friday</li></ul></section>' +
        '<section id="b"><p>He said <em>never</em>.</p></section></body>',
      ["a", "b"],
    );
    // Cut as HTML rather than as text, so a list arrives at the converter as a list
    expect(parts[1].text).toBe("-   Monday\n-   Friday");
    expect(parts[2].text).toBe("He said *never*.");
  });

  test("a cut through emphasis leaves both halves of it emphasised", async () => {
    const parts = await sectionParts(
      '<body><p><em>Rain fell. <a id="b"></a>He signed twice.</em></p></body>',
      ["b"],
    );
    // The walk descends into an element an anchor sits inside, and what it emits is that element's
    // children. Emitted bare, the `<em>` is gone from both sides of the cut — and the EPUB, which
    // is the only other place that mark existed, is not kept.
    expect(parts.map((p) => p.text)).toEqual(["*Rain fell.*", "*He signed twice.*"]);
  });

  test("a cut through a span carries its styling into the part it opens", async () => {
    const parts = await sectionParts(
      '<body><p><span style="font-style: italic">Rain fell. <a id="b"></a>He signed.</span></p></body>',
      ["b"],
    );
    expect(parts.map((p) => p.text)).toEqual(["*Rain fell.*", "*He signed.*"]);
  });

  test("an anchor the file does not contain produces no chapter, and loses no text", async () => {
    const parts = await sectionParts(
      '<body><section id="a"><p>Alpha.</p></section><p>Beta.</p></body>',
      ["a", "missing"],
    );
    expect(parts.map((p) => p.id)).toEqual([null, "a"]);
    // "Beta." sat after the anchor and stays with it — not lost, and not a chapter of its own.
    expect(parts.map((p) => p.text)).toEqual(["", "Alpha.\n\nBeta."]);
  });

  test("a word needs a letter or a digit in it", () => {
    // a rule of dashes is not eleven words
    expect(countWords("— — — — —")).toBe(0);
    expect(countWords("He signed the line twice.")).toBe(5);
  });

  test("text without spaces is counted by its characters, not as one word", () => {
    // a chapter of Chinese prose has no spaces at all; counting words would report 1
    expect(countWords("他抬起头，望向远处的山峦")).toBeGreaterThan(5);
  });
});

describe("the entities an XHTML file names", () => {
  test("HTML's names become the numeric references XML knows, and nothing else changes", () => {
    expect(numericEntities("A&nbsp;B &mdash; C&hellip;")).toBe("A&#160;B &#8212; C&#8230;");
    // XML's own five are read correctly already, and a name HTML does not have is not guessed at.
    expect(numericEntities("&amp; &lt; &gt; &quot; &apos; &bogus;")).toBe(
      "&amp; &lt; &gt; &quot; &apos; &bogus;",
    );
    // Without its semicolon it is not an entity to an XML parser, whatever HTML would make of it.
    expect(numericEntities("&nbsp and &copy")).toBe("&nbsp and &copy");
    // A few names are two characters.
    expect(numericEntities("&NotEqualTilde;")).toBe("&#8770;&#824;");
  });

  test("a chapter written with them imports as the characters, not the names", async () => {
    // EPUB 2 and Calibre books with an XHTML 1.1 doctype write these everywhere, and an XML parser
    // that does not read the DTD left them as text for the narrator to spell out.
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({
        chapters: [
          {
            title: "One",
            raw: "<p>Mr.&nbsp;Hale paused &mdash; then went on&hellip; &ldquo;Fine,&rdquo; he said.</p>",
          },
        ],
      }),
    );
    const id = body.book.id;
    const { body: text } = await api.request<{ text: string }>(
      `/api/books/${id}/chapters/1/text?format=plain`,
    );
    expect(text.text).toBe("Mr.\u00a0Hale paused — then went on… “Fine,” he said.");
    expect(body.chapters[0].words).toBe(9);
  });
});
