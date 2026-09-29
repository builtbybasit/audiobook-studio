// The Library shelf: the one next thing a card says about a book, as a verb with a destination;
// and the search, the filters and the order that make a shelf of twenty books usable.
import { test, expect, describe } from "bun:test";

import type { BookFacts } from "@/views/library/bookFacts";
import { hours, nextStepOf, updateReason } from "@/views/library/shared";
import {
  filterCounts,
  matchesQuery,
  shelfView,
  sortEntries,
  todoScore,
  type ShelfEntry,
} from "@/views/library/shelf";
import type { Book, BookProgress } from "@/types";

const progress = (over: Partial<BookProgress> = {}): BookProgress => ({
  total: 24,
  excluded: 0,
  scripted: 24,
  fallback: 0,
  narrated: 24,
  stale: 0,
  exported: 0,
  running: false,
  ...over,
});
const quiet = {
  failedScripting: 0,
  failedNarration: 0,
  unreviewed: 0,
  unvoiced: 0,
  exports: 0,
  behind: false,
  building: false,
};

describe("the next step on a card", () => {
  test("follows the pipeline: script, retry, re-narrate, narrate, script more, build, update", () => {
    expect(nextStepOf(progress({ scripted: 0, narrated: 0 }), quiet)).toMatchObject({
      label: "Start scripting",
      to: "scripting",
    });
    expect(
      nextStepOf(progress({ scripted: 12, narrated: 3 }), { ...quiet, failedScripting: 2 }),
    ).toMatchObject({ label: "Retry 2 failed chapters", to: "scripting", tone: "red" });
    expect(nextStepOf(progress({ narrated: 20, stale: 1 }), quiet)).toMatchObject({
      label: "Re-narrate 1 stale chapter",
      to: "narration",
    });
    expect(nextStepOf(progress({ scripted: 12, narrated: 3 }), quiet)).toMatchObject({
      label: "Narrate 9 chapters",
      to: "narration",
    });
    expect(nextStepOf(progress({ scripted: 12, narrated: 12 }), quiet)).toMatchObject({
      label: "Script 12 more",
      to: "scripting",
    });
    expect(nextStepOf(progress(), quiet)).toMatchObject({
      label: "Build the audiobook",
      to: "export",
    });
    expect(nextStepOf(progress(), { ...quiet, exports: 1, behind: true })).toMatchObject({
      label: "Update the audiobook",
      to: "export",
    });
    expect(nextStepOf(progress(), { ...quiet, exports: 1 })).toMatchObject({
      label: "Audiobook up to date",
      tone: "emerald",
    });
    expect(nextStepOf(progress(), { ...quiet, building: true }).label).toContain("Building");
  });

  test("the cast steps the overview used to own are in the one chain", () => {
    // These three used to exist only in BookView's private copy, so a card could never say them.
    expect(nextStepOf(progress(), { ...quiet, unreviewed: 2 })).toMatchObject({
      label: "Review cast",
      to: "cast",
    });
    expect(nextStepOf(progress({ fallback: 1 }), quiet)).toMatchObject({
      label: "Inspect fallbacks",
      to: "scripting",
    });
    expect(nextStepOf(progress(), { ...quiet, unvoiced: 3 })).toMatchObject({
      label: "Assign voices",
      to: "narration",
    });
  });

  test("a stale chapter no longer hides a speaker waiting to be reviewed", () => {
    // The bug this chain was merged for: the shelf said "Re-narrate 1 stale chapter" while the
    // book's own overview said a new speaker needed review. One question, one answer.
    const step = nextStepOf(progress({ narrated: 20, stale: 1 }), { ...quiet, unreviewed: 1 });
    expect(step.label).toBe("Review cast");
    expect(step.text).toBe("1 newly detected speaker needs review — probably aliases to merge.");
  });

  test("a failure outranks a review, so the attention filter still finds it", () => {
    const step = nextStepOf(progress({ scripted: 12, narrated: 3 }), {
      ...quiet,
      failedScripting: 1,
      unreviewed: 4,
    });
    expect(step).toMatchObject({ label: "Retry 1 failed chapter", tone: "red" });
  });

  test("every step carries both a verb and a sentence", () => {
    const steps = [
      nextStepOf(progress({ total: 0, scripted: 0, narrated: 0 }), quiet),
      nextStepOf(progress({ scripted: 0, narrated: 0 }), quiet),
      nextStepOf(progress(), { ...quiet, failedScripting: 1 }),
      nextStepOf(progress(), { ...quiet, unreviewed: 1 }),
      nextStepOf(progress({ fallback: 2 }), quiet),
      nextStepOf(progress(), { ...quiet, unvoiced: 1 }),
      nextStepOf(progress({ stale: 2 }), quiet),
      nextStepOf(progress(), { ...quiet, failedNarration: 1 }),
      nextStepOf(progress({ scripted: 12, narrated: 3 }), quiet),
      nextStepOf(progress({ scripted: 12, narrated: 12 }), quiet),
      nextStepOf(progress(), { ...quiet, building: true }),
      nextStepOf(progress(), quiet),
      nextStepOf(progress(), { ...quiet, exports: 1, behind: true }),
      nextStepOf(progress(), { ...quiet, exports: 1 }),
    ];
    for (const step of steps) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.text.length).toBeGreaterThan(0);
    }
  });

  test("a book with every chapter skipped points back at the contents review", () => {
    expect(
      nextStepOf(progress({ total: 0, scripted: 0, narrated: 0, excluded: 5 }), quiet).to,
    ).toBe("contents");
  });

  test("running time reads the way a listener says it", () => {
    expect(hours(4 * 3600 + 12 * 60)).toBe("4h 12m");
    expect(hours(38 * 60 + 20)).toBe("38 min");
    expect(hours(10)).toBe("1 min");
  });

  test("an audiobook that is behind says what happened, most consequential reason first", () => {
    const u = { added: [], changed: [], stale: [], missing: [], settings: [] };
    expect(updateReason(u)).toBe("");
    expect(updateReason({ ...u, added: [7, 8, 9] })).toBe("3 chapters not in it yet");
    expect(updateReason({ ...u, changed: [2] })).toBe("1 chapter re-narrated since");
    expect(updateReason({ ...u, stale: [2, 3] })).toBe("2 chapters stale");
    expect(updateReason({ ...u, settings: ["Bitrate"] })).toBe("output settings changed");
    expect(updateReason({ ...u, added: [1], missing: [4] })).toBe("1 chapter lost its audio");
  });
});

// ---- the pure side of the shelf, over hand-made facts
const book = (id: string, title: string, author: string, addedAt = "2026-08-01"): Book => ({
  id,
  title,
  author,
  cover: ["#000", "#fff"],
  addedAt,
  volumes: [],
});
const facts = (over: Partial<BookFacts> = {}, p: Partial<BookProgress> = {}): BookFacts => ({
  progress: progress(p),
  contents: { total: 24, included: 24, skipped: 0, suggested: 0, review: 0, kept: 0, noted: 0 },
  next: nextStepOf(progress(p), quiet),
  unreviewed: 0,
  unvoiced: 0,
  activity: "",
  running: false,
  failedJobs: 0,
  latest: null,
  behind: false,
  behindWhy: "",
  building: false,
  failedScripting: 0,
  failedNarration: 0,
  ...over,
});

describe("finding a book on the shelf", () => {
  test("every word has to be in the title or the author, accents and case aside", () => {
    const b = book("x", "The Cliché Cultivation World", "Unknown Daoist");
    expect(matchesQuery(b, "cliche")).toBe(true);
    expect(matchesQuery(b, "world daoist")).toBe(true);
    expect(matchesQuery(b, "  ")).toBe(true);
    expect(matchesQuery(b, "cliche gates")).toBe(false);
  });

  test("the filters split the shelf by what a book needs, and the chips count what each keeps", () => {
    const entries: ShelfEntry[] = [
      { book: book("a", "A", "x"), facts: facts({ failedJobs: 1 }) },
      { book: book("b", "B", "x"), facts: facts({ running: true }, { scripted: 10, narrated: 2 }) },
      {
        book: book("c", "C", "x"),
        facts: facts({
          behind: true,
          next: nextStepOf(progress(), { ...quiet, exports: 1, behind: true }),
        }),
      },
      {
        book: book("d", "D", "x"),
        facts: facts({ next: nextStepOf(progress(), { ...quiet, exports: 1 }) }),
      },
    ];
    expect(shelfView(entries, { filter: "attention" }).map((e) => e.book.id)).toEqual(["a"]);
    expect(shelfView(entries, { filter: "running" }).map((e) => e.book.id)).toEqual(["b"]);
    expect(shelfView(entries, { filter: "behind" }).map((e) => e.book.id)).toEqual(["c"]);
    expect(shelfView(entries, { filter: "done" }).map((e) => e.book.id)).toEqual(["d"]);
    expect(filterCounts(entries)).toEqual({ all: 4, attention: 1, running: 1, behind: 1, done: 1 });
    // the counts respect the search, so a chip never promises a book the search hides
    expect(filterCounts(entries, "C").all).toBe(1);
  });

  test("each order has the one direction that is useful", () => {
    const entries: ShelfEntry[] = [
      {
        book: book("old", "Zebra", "Adams", "2026-05-01"),
        facts: facts({}, { scripted: 0, narrated: 0 }),
      },
      { book: book("new", "apple", "Brown", "2026-09-01"), facts: facts() },
      { book: book("now", "Mango", "Clark", "just now"), facts: facts({ failedJobs: 1 }) },
    ];
    const ids = (s: Parameters<typeof sortEntries>[1]) =>
      sortEntries(entries, s).map((e) => e.book.id);
    expect(ids("added")).toEqual(["now", "new", "old"]);
    expect(ids("title")).toEqual(["new", "now", "old"]);
    expect(ids("author")).toEqual(["old", "new", "now"]);
    // broken work first, then the most unstarted, and a finished book last
    expect(ids("todo")).toEqual(["now", "old", "new"]);
    expect(ids("scripted")).toEqual(["old", "new", "now"]);
    expect(todoScore(facts({ next: nextStepOf(progress(), { ...quiet, exports: 1 }) }))).toBe(0);
  });
});
