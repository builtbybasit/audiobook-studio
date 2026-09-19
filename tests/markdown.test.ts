// Drawing a chapter that came out of a file somebody uploaded.
//
// The contents review shows the chapter as the EPUB laid it out, tables included. That means book
// text reaches a template, so the two things worth testing are what a link is allowed to point at
// and that a run of stress arrives as something the template can draw without unpicking it.
import { describe, expect, test } from "bun:test";

import { blocksOf, inlineOf, piecesOf, rowsOf, safeHref } from "@/lib/markdown";
import type { Tokens } from "marked";

const inline = (markdown: string) => inlineOf(blocksOf(markdown)[0]);
const said = (markdown: string) => inline(markdown).map((p) => `${p.kind}:${p.text}`);

describe("what a link may point at", () => {
  test("the schemes a book has business linking to are kept", () => {
    expect(safeHref("https://example.test/a")).toBe("https://example.test/a");
    expect(safeHref("http://example.test")).toBe("http://example.test");
    expect(safeHref("mailto:someone@example.test")).toBe("mailto:someone@example.test");
  });

  test("a script in an href is not one of them", () => {
    // the other half of "import this EPUB", if the target ever reached an anchor
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
  });

  test("control characters do not make a new scheme out of an old one", () => {
    // `java\nscript:` is `javascript:` to a browser and something else to a naive regex
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref(" javascript:alert(1)")).toBeNull();
  });

  test("a link inside the archive has no target, because the archive is not kept", () => {
    expect(safeHref("../text/c2.xhtml")).toBeNull();
    expect(safeHref("#footnote-3")).toBeNull();
  });

  test("a link that cannot be followed still shows its words", () => {
    const [piece] = inline("See [the note](javascript:alert(1)).");
    expect(piece.kind).toBe("text");
    const link = inline("See [the note](javascript:alert%281%29).").find((p) => p.kind === "link");
    // whichever way marked tokenises it, the words survive and the target does not
    expect(link?.href ?? null).toBeNull();
  });
});

describe("flattening an inline run", () => {
  test("the two grades of stress stay apart", () => {
    expect(said("He said *never*, and **meant** it.")).toEqual([
      "text:He said ",
      "em:never",
      "text:, and ",
      "strong:meant",
      "text: it.",
    ]);
  });

  test("a word that is both arrives as one piece, not as one inside another", () => {
    expect(said("He said ***never*** again.")).toEqual([
      "text:He said ",
      "both:never",
      "text: again.",
    ]);
  });

  test("a mark that only covers part of another keeps both grades", () => {
    expect(said("**a *b* c** d")).toEqual(["strong:a ", "both:b", "strong: c", "text: d"]);
  });

  test("an image is not prose, and its alt text is not either", () => {
    expect(said("Rain ![a plate](cover.jpg) fell.")).toEqual(["text:Rain ", "text: fell."]);
  });

  test("a link's words are a run of their own, so an italic link is still italic", () => {
    const [link] = inline("See [*the note*](http://example.test/a).").filter(
      (p) => p.kind === "link",
    );
    expect(link).toEqual({
      kind: "link",
      href: "http://example.test/a",
      pieces: [{ kind: "em", text: "the note" }],
    });
  });

  test("stress around a link reaches the words inside it", () => {
    // Read off the link's own `text` instead, both of these draw the stars or lose the stress.
    const bold = inline("See **[the note](http://example.test/a)**.").filter(
      (p) => p.kind === "link",
    );
    expect(bold[0].pieces).toEqual([{ kind: "strong", text: "the note" }]);
    const both = inline("See ***[the note](http://example.test/a)***.").filter(
      (p) => p.kind === "link",
    );
    expect(both[0].pieces).toEqual([{ kind: "both", text: "the note" }]);
  });

  test("a link nobody may follow still keeps the stress in its words", () => {
    const [link] = inline("See [*the note*](javascript:alert%281%29).").filter(
      (p) => p.kind === "link",
    );
    expect(link.href).toBeNull();
    expect(link.pieces).toEqual([{ kind: "em", text: "the note" }]);
  });
});

describe("blocks the review has to draw", () => {
  test("a table comes through as its header and its rows", () => {
    const [block] = blocksOf("| Day | Chapter |\n| --- | --- |\n| Monday | Ch 1 |");
    expect(block.type).toBe("table");
    const rows = rowsOf(block as Tokens.Table);
    expect(rows.map((r) => r.head)).toEqual([true, false]);
    expect(rows.map((r) => r.cells.map((c) => piecesOf(c.tokens, c.text)[0]?.text))).toEqual([
      ["Day", "Chapter"],
      ["Monday", "Ch 1"],
    ]);
  });

  test("a table the file gave no header does not draw a blank row above it", () => {
    // The converter writes an empty header row for a table with no `<th>`, which is how a good
    // deal of older prose is laid out. Drawn, it is a blank first row the book never had.
    const [block] = blocksOf("|  |  |\n| --- | --- |\n| Rain fell. | He signed. |");
    const rows = rowsOf(block as Tokens.Table);
    expect(rows.map((r) => r.head)).toEqual([false]);
    expect(rows[0].cells.map((c) => c.text)).toEqual(["Rain fell.", "He signed."]);
  });

  test("a heading knows how deep it is", () => {
    const [block] = blocksOf("## Chapter Twelve");
    expect(block.type).toBe("heading");
    expect((block as Tokens.Heading).depth).toBe(2);
    expect(inlineOf(block).map((p) => p.text)).toEqual(["Chapter Twelve"]);
  });

  test("plain prose parses to itself, so the review draws one way and not two", () => {
    // The seeded demo produces prose and the backend produces Markdown. They go through the same
    // renderer because plain prose *is* Markdown: paragraphs split on the blank line, and nothing
    // in it means anything else.
    const prose = "He signed the line twice.\n\nRain fell on the counting house.";
    expect(blocksOf(prose).map((b) => b.type)).toEqual(["paragraph", "space", "paragraph"]);
    expect(
      blocksOf(prose)
        .filter((b) => b.type === "paragraph")
        .map(inlineOf)
        .flat(),
    ).toEqual([
      { kind: "text", text: "He signed the line twice." },
      { kind: "text", text: "Rain fell on the counting house." },
    ]);
  });

  test("a list item holds blocks, which is how a list under a list survives", () => {
    // The renderer draws an item by recursing into these, not as one inline run: read as a run,
    // the child list is a token with no text of its own and “Child” is simply gone.
    const [list] = blocksOf("- Parent\n  - Child");
    const [item] = (list as Tokens.List).items;
    expect(item.tokens.map((t) => t.type)).toEqual(["text", "list"]);
    expect(inlineOf(item.tokens[0]).map((p) => p.text)).toEqual(["Parent"]);
    const child = item.tokens[1] as Tokens.List;
    expect(inlineOf(child.items[0].tokens[0]).map((p) => p.text)).toEqual(["Child"]);
  });

  test("a scene break is a break, not three stars to read out", () => {
    // Parsed, `* * *` is a rule and narration drops it. Left as literal text it would be three
    // asterisks handed to a speech provider — so parsing is the safer reading, not the risky one.
    expect(blocksOf("He signed.\n\n* * *\n\nRain fell.").map((b) => b.type)).toContain("hr");
  });
});
