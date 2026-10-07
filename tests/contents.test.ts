// The contents review: import → review → add, and the same review afterwards.
//
// Two things matter and neither is visible from a screenshot. A suggestion never removes anything:
// a chapter the import flagged is included until the person acts, and the import button counts it.
// And a skipped chapter is skipped everywhere: the stages, the run totals and the export readiness
// all read the one flag the review sets, and restoring it puts it back everywhere at once.
//
// The pure side reads what it is handed. The store is driven against the demo library, whose Demo
// tools open the review on each of the import samples below, and which reads a real EPUB as one
// more volume of a book.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { IMPORT_SAMPLES } from "~/demo/seed/fixtures/imports";
import { importedBook } from "~/demo/seed/world/imports";
import { chapterParts } from "~/demo/seed/world/text";
import { readinessOf } from "@/lib/exports";
import { chapterNumbers } from "@/lib/chapterNumber";
import { findsChapter, numberCell, numberSpan } from "@/lib/chapterNumber";
import {
  excerptOf,
  importLabel,
  isUndecided,
  noticeGroups,
  stateOf,
  summarize,
} from "@/lib/contents";
import { passes } from "@/views/contents/shared";
import { libraryService } from "@/services/library";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useUiStore } from "@/stores/ui";
import type { Chapter } from "@/types";
import { demoServer, type DemoServer } from "./support/demoServer";
import { epubFile, story } from "./support/epub";
import { testPinia, type TestPinia } from "./support/pinia";

const chapter = (over: Partial<Chapter> = {}): Chapter => ({
  id: 1,
  index: 1,
  volumeId: 1,
  volumeIndex: 1,
  title: "A chapter",
  words: 3000,
  scripting: "none",
  scriptingProgress: 0,
  narration: "none",
  narrationProgress: 0,
  duration: 0,
  ...over,
});
const hiatus = { verdict: "skip" as const, kind: "hiatus" as const, reason: "r", evidence: [] };
const mixed = { verdict: "review" as const, kind: "mixed" as const, reason: "r", evidence: [] };

describe("the pure side", () => {
  test("a note is a suggestion until the person acts, and the counts say which is which", () => {
    const chapters = [
      chapter({ id: 1 }),
      chapter({ id: 2, note: hiatus }),
      chapter({ id: 3, note: hiatus, excluded: true }),
      chapter({ id: 4, note: mixed }),
      chapter({ id: 5, note: mixed, kept: true }),
      chapter({ id: 6, excluded: true }),
    ];
    expect(chapters.map(stateOf)).toEqual([
      "included",
      "suggested",
      "skipped",
      "review",
      "kept",
      "skipped",
    ]);
    expect(chapters.map(isUndecided)).toEqual([false, true, false, true, false, false]);
    expect(summarize(chapters)).toEqual({
      total: 6,
      included: 4,
      skipped: 2,
      suggested: 1,
      review: 1,
      kept: 1,
      noted: 4,
    });
    const groups = noticeGroups(chapters);
    expect(groups.map((g) => g.kind)).toEqual(["hiatus", "mixed"]);
    expect(groups[0]).toMatchObject({ ids: [2, 3], pending: [2], skipped: 1, kept: 0 });
    expect(groups[1]).toMatchObject({ ids: [4, 5], pending: [4], skipped: 0, kept: 1 });
  });

  test("the import button names what goes in", () => {
    expect(importLabel("book", 208)).toBe("Add to library · 208 chapters");
    expect(importLabel("volume", 1)).toBe("Add volume · 1 chapter");
    expect(excerptOf("word ".repeat(100), 40).endsWith("…")).toBe(true);
    expect(excerptOf("short")).toBe("short");
  });
});

describe("the import samples", () => {
  test("every sample reads into continuous chapters, volumes that cover them, and nothing skipped", () => {
    for (const s of IMPORT_SAMPLES) {
      const { book, chapters } = importedBook(s.id, "x");
      expect(book.importing, s.id).toBe(true);
      expect(book.sample, s.id).toBe(s.id);
      expect(
        chapters.map((c) => c.id),
        s.id,
      ).toEqual(chapters.map((_, i) => i + 1));
      let from = 1;
      for (const v of book.volumes) {
        expect(v.from, s.id).toBe(from);
        const mine = chapters.filter((c) => c.volumeId === v.id);
        expect(v.to, s.id).toBe(from + mine.length - 1);
        expect(
          mine.map((c) => c.volumeIndex),
          s.id,
        ).toEqual(mine.map((_, i) => i + 1));
        from = v.to + 1;
      }
      expect(
        chapters.some((c) => c.excluded || c.kept),
        s.id,
      ).toBe(false);
      for (const c of chapters.filter((c) => c.note)) {
        expect(c.note!.reason.length, `${s.id} #${c.id}`).toBeGreaterThan(0);
        expect(c.note!.evidence.length, `${s.id} #${c.id}`).toBeGreaterThan(0);
      }
    }
  });

  test("the situations the review has to survive are all there", () => {
    const by = Object.fromEntries(IMPORT_SAMPLES.map((s) => [s.id, importedBook(s.id, "x")]));
    // a clean book: nothing flagged, so no review step is forced
    expect(summarize(by.clean.chapters).noted).toBe(0);
    expect(by.clean.chapters.some((c) => /Prologue|Epilogue|Interlude|Bonus/.test(c.title))).toBe(
      true,
    );
    // a long serial with updates scattered through, a duplicate among them
    expect(by.serial.chapters.length).toBeGreaterThan(100);
    const serial = noticeGroups(by.serial.chapters);
    expect(serial.some((g) => g.kind === "hiatus")).toBe(true);
    expect(serial.some((g) => g.kind === "duplicate")).toBe(true);
    // volumes with notices between the story
    expect(by.volumes.book.volumes.length).toBeGreaterThan(1);
    for (const v of by.volumes.book.volumes) {
      const mine = by.volumes.chapters.filter((c) => c.volumeId === v.id);
      expect(mine[0].note?.verdict).toBe("skip");
      expect(mine.at(-1)!.note?.kind).toBe("afterword");
    }
    // one announcement repeated, so one decision covers it
    const repeated = noticeGroups(by.repeated.chapters);
    expect(repeated.find((g) => g.kind === "sponsor")!.ids.length).toBeGreaterThan(1);
    expect(repeated.find((g) => g.kind === "vote")!.ids.length).toBeGreaterThan(1);
    // titles that only look like notices are a look, never a skip
    const looks = by.misleading.chapters.filter((c) => c.note?.kind === "title");
    expect(looks.length).toBeGreaterThan(3);
    for (const c of looks) expect(c.note?.verdict).toBe("review");
    // a note and story together are told apart from a notice through and through
    const mix = by.mixed.chapters.filter((c) => c.note?.kind === "mixed");
    expect(mix.length).toBeGreaterThan(0);
    expect(mix.every((c) => c.note?.verdict === "review" && c.words > 2000)).toBe(true);
    expect(by.mixed.chapters.some((c) => c.note?.verdict === "skip")).toBe(true);
    // nothing but notices, with titles too long for a row
    expect(by.notices.chapters.every((c) => c.note?.verdict === "skip")).toBe(true);
    expect(by.notices.chapters.every((c) => c.title.length > 60)).toBe(true);
  });

  test("a chapter reads as what its note says, with the note marked", () => {
    const { chapters } = importedBook("mixed", "x");
    const start = chapters.find((c) => c.note?.kind === "mixed" && c.note.at === "start")!;
    const end = chapters.find((c) => c.note?.kind === "mixed" && c.note.at === "end")!;
    const whole = chapters.find((c) => c.note?.verdict === "skip")!;
    const story = chapters.find((c) => !c.note)!;
    expect(chapterParts("x", start.id, start, "cliche").map((p) => !!p.notice)).toEqual([
      true,
      false,
    ]);
    expect(chapterParts("x", end.id, end, "cliche").map((p) => !!p.notice)).toEqual([false, true]);
    expect(chapterParts("x", whole.id, whole, "cliche").map((p) => !!p.notice)).toEqual([true]);
    expect(chapterParts("x", story.id, story, "cliche").map((p) => !!p.notice)).toEqual([false]);
    // a title that only looks like a notice reads as story
    const looks = importedBook("misleading", "y").chapters.find((c) => c.note?.kind === "title")!;
    expect(chapterParts("y", looks.id, looks, "drowned").map((p) => !!p.notice)).toEqual([false]);
  });
});

describe("the review against the demo library", () => {
  let demo: DemoServer;
  let pinia: TestPinia;
  let libraryStore: ReturnType<typeof useLibraryStore>;
  let toasts: { msg: string; undo: (() => void | Promise<void>) | null }[];
  beforeAll(async () => {
    Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
    demo = await demoServer();
  });
  // No reset before each test: a test that opens an import sample is given a freshly seeded demo
  // by the situation itself, which lays the whole seed down again, and the rest read or add to
  // seeded books no other test here changes. Seeding is most of what each of these costs.
  beforeEach(() => {
    pinia = testPinia();
    libraryStore = useLibraryStore();
    toasts = [];
    useUiStore().toast = (msg, opts = {}) => {
      toasts.push({ msg, undo: opts.undo ?? null });
      return "test";
    };
  });
  afterEach(() => pinia.stop());

  /** The Demo tools' row for an import sample: the book it reads, waiting in its review. */
  async function imported(sample: string): Promise<string> {
    const id = `import-${sample}`;
    await demo.situate(id);
    await libraryStore.load(true);
    await libraryStore.loadBook(id);
    return id;
  }
  /** One more volume of a book: a story chapter, a hiatus notice the import flags, and another. */
  const volume = () =>
    epubFile({
      chapters: [
        { title: "Four", paragraphs: story() },
        {
          title: "A short break",
          paragraphs: [
            "Going on hiatus for a few weeks. Thank you for reading, and for your patience.",
          ],
        },
        { title: "Five", paragraphs: story() },
      ],
    });

  describe("import → review → add", () => {
    test("a read file waits off the shelf until it is confirmed, and confirming starts nothing", async () => {
      const id = await imported("serial");
      expect(libraryStore.bookById(id)?.importing).toBe(true);
      expect(libraryStore.shelved.some((b) => b.id === id)).toBe(false);
      const s = libraryStore.contentsOf(id);
      expect(s.suggested).toBeGreaterThan(5);
      expect(s.included).toBe(s.total); // suggestions have removed nothing
      await libraryStore.confirmImport(id);
      expect(libraryStore.bookById(id)?.importing).toBeUndefined();
      expect(libraryStore.shelved.some((b) => b.id === id)).toBe(true);
      expect(libraryStore.chaptersOf(id).every((c) => c.scripting === "none")).toBe(true);
    });

    test("a new volume numbers on from the book and confirms into it", async () => {
      // no other test here adds to `cliche`, so it has no volume waiting whichever ran before
      await libraryStore.loadBook("cliche");
      const before = libraryStore.chaptersOf("cliche").length;
      await libraryStore.importVolume("cliche", { source: await volume(), name: "Vol. 4" });
      const added = libraryStore.chaptersOf("cliche").slice(before);
      expect(added[0].id).toBe(before + 1);
      expect(added.some((c) => c.note)).toBe(true);
      await libraryStore.confirmImport("cliche");
      expect(libraryStore.bookById("cliche")?.volumes.some((v) => v.importing)).toBe(false);
      expect(toasts.at(-1)?.msg).toContain("Vol. 4");
    });
  });

  describe("deciding", () => {
    test("a batch skip toasts with an Undo that puts every chapter back exactly", async () => {
      const id = await imported("repeated");
      const sponsor = libraryStore.noticeGroupsOf(id).find((g) => g.kind === "sponsor")!;
      // one of them already looked at and kept: the batch only covers what is pending
      await libraryStore.keepChapters(id, [sponsor.ids[0]], { quiet: true });
      const pending = libraryStore.noticeGroupsOf(id).find((g) => g.kind === "sponsor")!.pending;
      expect(pending.length).toBeGreaterThan(1);
      const suggested0 = libraryStore.contentsOf(id).suggested;
      expect(await libraryStore.skipChapters(id, pending, true)).toBe(pending.length);
      // the toast counts what the batch covered, whatever size the batch was
      expect(toasts.at(-1)?.msg).toContain(String(pending.length));
      expect(libraryStore.contentsOf(id)).toMatchObject({
        skipped: pending.length,
        kept: 1,
        suggested: suggested0 - pending.length,
      });
      await toasts.at(-1)!.undo!();
      // undo puts every one of them back where it was
      expect(libraryStore.contentsOf(id)).toMatchObject({
        skipped: 0,
        kept: 1,
        suggested: suggested0,
      });
      expect(libraryStore.chapter(id, sponsor.ids[0])?.kept).toBe(true);
    });

    test("including a flagged chapter again counts as having looked at it", async () => {
      const id = await imported("serial");
      const chId = libraryStore.chaptersOf(id).find((ch) => ch.note?.kind === "hiatus")!.id;
      const c = () => libraryStore.chapter(id, chId)!;
      await libraryStore.skipChapters(id, [chId], true, { quiet: true });
      expect(stateOf(c())).toBe("skipped");
      await libraryStore.skipChapters(id, [chId], false, { quiet: true });
      expect(stateOf(c())).toBe("kept");
      expect(isUndecided(c())).toBe(false);
      // a quiet single toggle does not toast; the click is its own undo
      expect(toasts.length).toBe(0);
    });

    test("a skipped chapter leaves every stage and comes back when restored", async () => {
      const scriptingStore = useScriptingStore();
      const id = await imported("clean");
      await libraryStore.confirmImport(id);
      const [a, b] = libraryStore.chaptersOf(id).map((c) => c.id);
      const count = libraryStore.chaptersOf(id).length;
      await libraryStore.skipChapters(id, [b], true, { quiet: true });
      expect(scriptingStore.scriptEstimate(id, [a, b]).chapters).toBe(1);
      expect(readinessOf(libraryStore.chapter(id, b)!)).toBe("skipped");
      // the progress total is what is still in the book
      expect(libraryStore.progress(id)).toMatchObject({ total: count - 1, excluded: 1 });
      await libraryStore.skipChapters(id, [b], false, { quiet: true });
      expect(scriptingStore.scriptEstimate(id, [a, b]).chapters).toBe(2);
      expect(readinessOf(libraryStore.chapter(id, b)!)).toBe("missing");
    });

    test("the seeded books explain the chapters they already skip", async () => {
      // read-only, and nothing in this file writes these chapters, so it reads the demo as it is
      const svc = libraryService();
      await Promise.all(["gates", "drowned"].map((id) => libraryStore.loadBook(id)));
      const gates = libraryStore.chaptersOf("gates").at(-1)!;
      expect(gates.excluded).toBe(true);
      expect(gates.note?.kind).toBe("afterword");
      expect(await svc.chapterText("gates", gates.id, "plain")).toContain("end of the volume");
      const drowned = libraryStore.chaptersOf("drowned").at(-1)!;
      expect(drowned.note?.kind).toBe("translator");
      // a story chapter of a seeded book still reads as its own prose
      expect(await svc.chapterText("cliche", 1, "plain")).toContain("Ji Ning");
    });
  });
});

// Reading numbers on screen: a list shows, spans and searches by the number a chapter has among
// the kept ones, so a skipped cover and contents page never push "Chapter 2" to "ch 4".
describe("reading numbers in the lists", () => {
  // the book's file: a cover and a contents page (skipped), then three chapters, one skipped
  const book = [
    chapter({ id: 1, title: "Cover", excluded: true }),
    chapter({ id: 2, title: "Information", excluded: true }),
    chapter({ id: 3, title: "Chapter 1" }),
    chapter({ id: 4, title: "Chapter 2" }),
    chapter({ id: 5, title: "Author's note", excluded: true }),
    chapter({ id: 6, title: "Chapter 3" }),
  ];
  const numbers = chapterNumbers(book);

  test("a row's number column pads the reading number and gives a skipped chapter a dash", () => {
    expect(numberCell(numbers.get(4))).toBe("02");
    expect(numberCell(numbers.get(6), 3)).toBe("003");
    expect(numberCell(numbers.get(1))).toBe("–");
  });

  test("a typed number finds the chapter with that reading number, never the one with that id", () => {
    const found = (q: string) =>
      book.filter((c) => findsChapter(c.title, numbers.get(c.id), q)).map((c) => c.id);
    expect(found("2")).toEqual([4]);
    expect(found("02")).toEqual([4]);
    expect(found("5")).toEqual([]);
    expect(found("4")).toEqual([]);
    expect(found("cover")).toEqual([1]);
  });

  test("the contents search finds by reading number too, and still by the note's reason", () => {
    const noted = chapter({ id: 7, title: "Notice", note: { ...hiatus, reason: "on hiatus" } });
    const all = [...book, noted];
    const nums = chapterNumbers(all);
    const found = (q: string) =>
      all.filter((c) => passes(c, nums.get(c.id), "all", null, q)).map((c) => c.id);
    expect(found("3")).toEqual([6]);
    expect(found("4")).toEqual([7]);
    expect(found("hiatus")).toEqual([7]);
  });

  test("a span names the first and last kept chapter it holds, by reading number", () => {
    expect(numberSpan([1, 2, 3, 4, 5, 6], numbers)).toBe("ch 1–3");
    expect(numberSpan([4, 5], numbers)).toBe("ch 2");
    expect(numberSpan([1, 2], numbers)).toBeNull();
    expect(numberSpan([3, 4], undefined)).toBeNull();
  });
});
