import { useDemoStore } from "@/stores/demo";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// The contents review: import → review → add, and the same review afterwards.
//
// Two things matter and neither is visible from a screenshot. A suggestion never removes anything:
// a chapter the import flagged is included until the person acts, and the import button counts it.
// And a skipped chapter is skipped everywhere: the stages, the run totals and the export readiness
// all read the one flag the review sets, and restoring it puts it back everywhere at once.
import { test, expect, beforeEach, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { IMPORT_SAMPLES, chapterParts, demoScenarios, importedBook } from "@/mock";
import { readinessOf } from "@/lib/exports";
import {
  excerptOf,
  importLabel,
  isUndecided,
  noticeGroups,
  stateOf,
  summarize,
} from "@/lib/contents";
import type { Chapter } from "@/types";

let demoStore: ReturnType<typeof useDemoStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;
let toasts: { msg: string; undo: (() => void) | null }[];

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  demoStore = useDemoStore();
  libraryStore = useLibraryStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  toasts = [];
  uiStore.toast = ((msg: string, opts: { undo?: (() => void) | null } = {}) => {
    toasts.push({ msg, undo: opts.undo ?? null });
    return "test";
  }) as typeof uiStore.toast;
});

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
      for (const c of chapters)
        if (c.note) {
          expect(c.note.reason.length, `${s.id} #${c.id}`).toBeGreaterThan(0);
          expect(c.note.evidence.length, `${s.id} #${c.id}`).toBeGreaterThan(0);
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
    expect(by.serial.chapters.length).toBeGreaterThan(200);
    const serial = noticeGroups(by.serial.chapters);
    expect(serial.some((g) => g.kind === "hiatus")).toBe(true);
    expect(serial.some((g) => g.kind === "duplicate")).toBe(true);
    // volumes with notices between the story
    expect(by.volumes.book.volumes.length).toBe(3);
    for (const v of by.volumes.book.volumes) {
      const mine = by.volumes.chapters.filter((c) => c.volumeId === v.id);
      expect(mine[0].note?.verdict).toBe("skip");
      expect(mine.at(-1)!.note?.kind).toBe("afterword");
    }
    // one announcement repeated, so one decision covers it
    const repeated = noticeGroups(by.repeated.chapters);
    expect(repeated.find((g) => g.kind === "sponsor")!.ids.length).toBe(12);
    expect(repeated.find((g) => g.kind === "vote")!.ids.length).toBe(6);
    // titles that only look like notices are a look, never a skip
    const looks = by.misleading.chapters.filter((c) => c.note?.kind === "title");
    expect(looks.length).toBeGreaterThan(3);
    for (const c of looks) expect(c.note?.verdict).toBe("review");
    // a note and story together are told apart from a notice through and through
    const mix = by.mixed.chapters.filter((c) => c.note?.kind === "mixed");
    expect(mix.length).toBe(5);
    expect(mix.every((c) => c.note?.verdict === "review" && c.words > 2000)).toBe(true);
    expect(by.mixed.chapters.filter((c) => c.note?.verdict === "skip").length).toBe(2);
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

describe("import → review → add", () => {
  test("a read file waits off the shelf until it is confirmed, and confirming starts nothing", () => {
    const id = libraryStore.importBook("serial");
    expect(libraryStore.bookById(id)?.importing).toBe(true);
    expect(libraryStore.shelved.some((b) => b.id === id)).toBe(false);
    const s = libraryStore.contentsOf(id);
    expect(s.suggested).toBeGreaterThan(5);
    expect(s.included).toBe(s.total); // suggestions have removed nothing
    libraryStore.confirmImport(id);
    expect(libraryStore.bookById(id)?.importing).toBeUndefined();
    expect(libraryStore.shelved.some((b) => b.id === id)).toBe(true);
    expect(libraryStore.chaptersOf(id).every((c) => c.scripting === "none")).toBe(true);
    expect(toasts.at(-1)?.msg).toContain("Added");
  });

  test("cancelling an import leaves no trace; cancelling a volume leaves the book as it was", () => {
    const id = libraryStore.importBook("clean");
    expect(libraryStore.discardImport(id)).toBe("book");
    expect(libraryStore.bookById(id)).toBeUndefined();
    expect(libraryStore.chaptersOf(id)).toEqual([]);

    const before = libraryStore.chaptersOf("cliche").length;
    const volId = libraryStore.importVolume("cliche", "volumes", "Vol 4.epub", "Vol. 4");
    expect(libraryStore.importingVolume("cliche")?.id).toBe(volId);
    expect(libraryStore.chaptersOf("cliche").length).toBeGreaterThan(before);
    expect(libraryStore.bookById("cliche")?.importing).toBeUndefined();
    expect(libraryStore.discardImport("cliche")).toBe("volume");
    expect(libraryStore.chaptersOf("cliche").length).toBe(before);
    expect(libraryStore.importingVolume("cliche")).toBeUndefined();
  });

  test("a new volume numbers on from the book and confirms into it", () => {
    const before = libraryStore.chaptersOf("cliche").length;
    libraryStore.importVolume("cliche", "volumes", "Vol 4.epub", "Vol. 4");
    const added = libraryStore.chaptersOf("cliche").slice(before);
    expect(added[0].id).toBe(before + 1);
    expect(added.some((c) => c.note)).toBe(true);
    libraryStore.confirmImport("cliche");
    expect(libraryStore.bookById("cliche")?.volumes.some((v) => v.importing)).toBe(false);
    expect(toasts.at(-1)?.msg).toContain("Vol. 4");
  });

  test("the Demo rows open the review on a book the row itself creates, and reset takes it away", () => {
    const rows = demoScenarios().filter((s) => s.group === "import");
    expect(rows.length).toBe(IMPORT_SAMPLES.length);
    for (const row of rows) {
      const to = demoStore.applyScenario(row.id);
      expect(to, row.id).toBe(row.path);
      expect(libraryStore.bookById(row.bookId)?.importing, row.id).toBe(true);
      expect(demoStore.survivesReset(row.bookId), row.id).toBe(false);
    }
    demoStore.resetDemo();
    for (const row of rows) expect(libraryStore.bookById(row.bookId)).toBeUndefined();
  });
});

describe("deciding", () => {
  test("a batch skip toasts with an Undo that puts every chapter back exactly", () => {
    const id = libraryStore.importBook("repeated");
    const sponsor = libraryStore.noticeGroupsOf(id).find((g) => g.kind === "sponsor")!;
    // one of them already looked at and kept: the batch only covers what is pending
    libraryStore.keepChapters(id, [sponsor.ids[0]], { quiet: true });
    const pending = libraryStore.noticeGroupsOf(id).find((g) => g.kind === "sponsor")!.pending;
    expect(pending.length).toBe(11);
    expect(libraryStore.skipChapters(id, pending, true)).toBe(11);
    expect(toasts.at(-1)?.msg).toBe("Skipped 11 chapters");
    expect(libraryStore.contentsOf(id)).toMatchObject({ skipped: 11, kept: 1, suggested: 6 });
    toasts.at(-1)!.undo!();
    expect(libraryStore.contentsOf(id)).toMatchObject({ skipped: 0, kept: 1, suggested: 17 });
    expect(libraryStore.chapter(id, sponsor.ids[0])?.kept).toBe(true);
  });

  test("including a flagged chapter again counts as having looked at it", () => {
    const id = libraryStore.importBook("serial");
    const c = libraryStore.chaptersOf(id).find((ch) => ch.note?.kind === "hiatus")!;
    libraryStore.skipChapters(id, [c.id], true, { quiet: true });
    expect(stateOf(c)).toBe("skipped");
    libraryStore.skipChapters(id, [c.id], false, { quiet: true });
    expect(stateOf(c)).toBe("kept");
    expect(isUndecided(c)).toBe(false);
    // a quiet single toggle does not toast; the click is its own undo
    expect(toasts.length).toBe(0);
  });

  test("a skipped chapter leaves every stage and comes back when restored", () => {
    const id = libraryStore.importBook("clean");
    libraryStore.confirmImport(id);
    const [a, b] = libraryStore.chaptersOf(id);
    libraryStore.skipChapters(id, [b.id], true, { quiet: true });
    expect(scriptingStore.scriptEstimate(id, [a.id, b.id]).chapters).toBe(1);
    expect(readinessOf(b)).toBe("skipped");
    expect(libraryStore.progress(id)).toMatchObject({ total: 17, excluded: 1 });
    libraryStore.skipChapters(id, [b.id], false, { quiet: true });
    expect(scriptingStore.scriptEstimate(id, [a.id, b.id]).chapters).toBe(2);
    expect(readinessOf(b)).toBe("missing");
  });

  test("the seeded books explain the chapters they already skip", () => {
    const gates = libraryStore.chaptersOf("gates").at(-1)!;
    expect(gates.excluded).toBe(true);
    expect(gates.note?.kind).toBe("afterword");
    expect(scriptsStore.rawText("gates", gates.id)).toContain("end of the volume");
    const drowned = libraryStore.chaptersOf("drowned").at(-1)!;
    expect(drowned.note?.kind).toBe("translator");
    // a story chapter of a seeded book still reads as its own prose
    expect(scriptsStore.rawText("cliche", 1)).toContain("Ji Ning");
  });
});
