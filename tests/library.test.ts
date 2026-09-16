import { useDemoStore } from "../src/stores/demo";
import { useJobsStore } from "../src/stores/jobs";
import { useLibraryStore } from "../src/stores/library";
import { useUiStore } from "../src/stores/ui";
// The Library shelf: the one next thing a card says about a book, as a verb with a destination;
// and the search, the filters and the order that make a shelf of twenty books usable.
import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { SHELF_BOOKS } from "../src/mock";
import { bookFacts, type BookFacts } from "../src/views/library/bookFacts";
import { hours, nextStepOf, updateReason } from "../src/views/library/shared";
import {
  filterCounts,
  matchesQuery,
  shelfView,
  sortEntries,
  todoScore,
  type ShelfEntry,
} from "../src/views/library/shelf";
import type { Book, BookProgress } from "../src/types";

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

// ---- the full shelf, from the demo row
describe("a full shelf", () => {
  let demoStore: ReturnType<typeof useDemoStore>;
  let libraryStore: ReturnType<typeof useLibraryStore>;
  let restore: (() => void)[] = [];
  beforeEach(() => {
    Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
    setActivePinia(createPinia());
    demoStore = useDemoStore();
    libraryStore = useLibraryStore();
    useJobsStore();
    useUiStore().toast = () => "test";
    // the row starts simulated runs; they are timer-driven and not what is under test here
    restore = [
      spyOn(globalThis, "setInterval").mockImplementation((() => 0) as typeof setInterval),
      spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as typeof setTimeout),
    ].map((s) => () => s.mockRestore());
  });
  afterEach(() => restore.forEach((f) => f()));

  test("adds every book in a state the filters tell apart, and reset takes them away", () => {
    const before = libraryStore.shelved.length;
    expect(demoStore.applyScenario("full-shelf")).toBe("/library");
    expect(libraryStore.shelved.length).toBe(before + SHELF_BOOKS.length);
    expect(libraryStore.books.some((b) => b.importing)).toBe(false);

    const entries: ShelfEntry[] = libraryStore.shelved.map((b) => ({
      book: b,
      facts: bookFacts(b.id),
    }));
    const by = Object.fromEntries(SHELF_BOOKS.map((b) => [b.id, b.state]));
    const state = (e: ShelfEntry) => by[e.book.id];
    const counts = filterCounts(entries);
    // among the new books, only the ones with failed scripting need attention
    const added = (f: "attention" | "behind" | "done") =>
      shelfView(entries, { filter: f }).filter((e) => state(e));
    expect(added("attention").map(state)).toEqual(["failed", "failed"]);
    expect(counts.attention).toBeGreaterThanOrEqual(2);
    expect(shelfView(entries, { filter: "behind" }).map(state)).toEqual(
      expect.arrayContaining(["behind"]),
    );
    expect(shelfView(entries, { filter: "done" }).map(state)).toEqual(
      expect.arrayContaining(["built"]),
    );
    expect(shelfView(entries, { filter: "done" }).some((e) => state(e) === "behind")).toBe(false);
    // and a book that is behind can say why
    for (const e of added("behind")) expect(e.facts.behindWhy).toBe("3 chapters not in it yet");
    // the running filter finds the seeded book the row starts scripting on
    expect(shelfView(entries, { filter: "running" }).map((e) => e.book.id)).toContain("cliche");
    // the search reaches the new books
    expect(shelfView(entries, { q: "harbour" }).map((e) => e.book.id)).toEqual(["shelf-grey"]);
    // and a review that was done leaves no chapter undecided
    for (const b of SHELF_BOOKS)
      expect(libraryStore.contentsOf(b.id).suggested + libraryStore.contentsOf(b.id).review).toBe(
        0,
      );

    demoStore.resetDemo();
    expect(libraryStore.shelved.length).toBe(before);
  });
});
