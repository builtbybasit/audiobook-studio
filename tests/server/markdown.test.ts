// The chapter text, as Markdown, and the two ways back out of it.
//
// Two things are worth a test of their own here. The converter is loaded through a bracket that
// hides `window` — because Turndown chooses its HTML parser once, from `window.DOMParser`, and this
// repository contains both halves of that trap. And `plainText` is what stands between the stored
// Markdown and a speech provider that would otherwise read a heading's `##` out loud and bill for
// it, so what it drops and what it keeps is a contract rather than a detail.
import { afterEach, describe, expect, test } from "bun:test";

import { DOMParser } from "linkedom";

import { parseEmphasis, plainText, toMarkdown, withoutWindow } from "~/epub/markdown";

const TABLE =
  "<body><table><tr><th>Day</th><th>Chapter</th></tr><tr><td>Monday</td><td>Ch 1</td></tr></table></body>";

type Globals = { window?: unknown };
const globals = globalThis as Globals;
const had = "window" in globals;
const saved = globals.window;

afterEach(() => {
  if (had) globals.window = saved;
  else delete globals.window;
});

describe("loading the converter", () => {
  test("a window stub carrying a DOMParser does not change what a table converts to", async () => {
    // Bound to linkedom instead of the DOM it ships with, Turndown's table plugin stops matching
    // and this collapses to "DayChapterMondayCh 1" — the exact `textContent` damage the extractor
    // exists to avoid, arriving silently and only in some import orders.
    globals.window = { DOMParser };
    expect(await toMarkdown(TABLE)).toBe("| Day | Chapter |\n| --- | --- |\n| Monday | Ch 1 |");
  });

  test("nothing is loaded while a window is visible", async () => {
    globals.window = { DOMParser };
    // What Turndown reads at the moment it is evaluated, and the whole reason for the bracket
    expect(await withoutWindow(async () => "window" in globals)).toBe(false);
  });

  test("stress a publisher wrote as styling is still stress", async () => {
    // Turndown's own rules match <em>, <i>, <strong> and <b>. A word stressed with inline CSS is a
    // span they have no rule for, and the archive is not kept: unmarked here is unmarked for good.
    expect(
      await toMarkdown(
        '<body><p>He said <span style="font-style: italic">never</span>.</p></body>',
      ),
    ).toBe("He said *never*.");
    expect(
      await toMarkdown('<body><p>He <span style="font-weight:700">meant</span> it.</p></body>'),
    ).toBe("He **meant** it.");
    expect(
      await toMarkdown(
        '<body><p><span style="font-style:italic;font-weight:bold">never</span></p></body>',
      ),
    ).toBe("***never***");
  });

  test("a span inside the emphasis it repeats does not double the marks", async () => {
    // `*` inside `*` is `**` to any Markdown parser: the stress would come back out as the other
    // grade entirely, which is the one distinction the import is keeping.
    expect(
      await toMarkdown(
        '<body><p><em>said <span style="font-style: italic">never</span></em></p></body>',
      ),
    ).toBe("*said never*");
  });

  test("a span that is not stressing anything is left alone", async () => {
    expect(await toMarkdown('<body><p>He said <span class="drop">never</span>.</p></body>')).toBe(
      "He said never.",
    );
  });

  test("the globals are left exactly as they were found", async () => {
    const stub = { DOMParser };
    globals.window = stub;
    await withoutWindow(async () => undefined);
    expect(globals.window).toBe(stub);

    delete globals.window;
    await withoutWindow(async () => undefined);
    // absent before, absent after — not present and undefined, which is a different thing
    expect("window" in globals).toBe(false);
  });

  test("a window is put back even when loading throws", async () => {
    const stub = { DOMParser };
    globals.window = stub;
    await expect(withoutWindow(() => Promise.reject(new Error("no such module")))).rejects.toThrow(
      "no such module",
    );
    expect(globals.window).toBe(stub);
  });
});

// A heading, a link, a table and an escaped star are read back beside the conversion that writes
// them, in epubImport.test.ts ("extracting a section's text"); these are the cases only this end has.
describe("reading the stored Markdown back", () => {
  test("a list loses its bullets and keeps its items apart", () => {
    expect(plainText("-   Monday\n-   Friday")).toBe("Monday\n\nFriday");
  });

  test("emphasis lands on the words themselves", () => {
    const { text, emphasis } = parseEmphasis("He said *never*, and **meant** it.");
    expect(text).toBe("He said never, and meant it.");
    expect(emphasis.map((e) => `${e.mark}:${text.slice(e.at, e.to)}`)).toEqual([
      "em:never",
      "strong:meant",
    ]);
  });

  test("a table the file gave no header does not open on a comma", async () => {
    // Old prose is laid out in tables with no <th>, and the converter writes an empty header row
    // above one. Narrated as a row, that is `, ` before the chapter has said anything.
    const table = await toMarkdown(
      "<body><table><tr><td>Rain fell.</td><td>He signed.</td></tr></table></body>",
    );
    expect(table).toContain("| Rain fell. | He signed. |");
    expect(plainText(table)).toBe("Rain fell., He signed.");
  });

  test("a run of stress is measured against the prose that comes back with it", () => {
    // The walk ends every block with a blank line and the prose is tidied afterwards. Measured
    // before that and left alone, the range here selects “ver a” — a word and a half to its left.
    const { text, emphasis } = parseEmphasis("  *never* again");
    expect(text).toBe("never again");
    expect(emphasis.map((e) => text.slice(e.at, e.to))).toEqual(["never"]);
  });

  test("stress after a block that padded the prose still lands on its own words", () => {
    const { text, emphasis } = parseEmphasis("```\nx\n\n\n```\n\nHe said *never*.");
    expect(emphasis.map((e) => text.slice(e.at, e.to))).toEqual(["never"]);
  });

  test("a horizontal rule is a break, not a row of dashes to read", () => {
    expect(plainText("Alpha.\n\n---\n\nBeta.")).toBe("Alpha.\n\nBeta.");
  });
});

describe("reading a long chapter back", () => {
  test("a single-file novel reads back in time proportional to its length", () => {
    // Under Bun, `marked`'s lexer took 30 seconds over 4,000 paragraphs, and asking the growing
    // prose whether it ended in a blank line was quadratic on its own. 64,000 paragraphs — a whole
    // long novel in one file — now reads in a few hundred milliseconds; the bound is loose enough
    // for a slow machine and far below either of those.
    const md = Array.from(
      { length: 64_000 },
      (_, i) => `Paragraph ${i} has *stress* and **more** in it, as prose does.`,
    ).join("\n\n");
    const started = performance.now();
    const { text, emphasis } = parseEmphasis(md);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(emphasis).toHaveLength(128_000);
    expect(text.startsWith("Paragraph 0 has stress and more in it")).toBe(true);
  });
});
