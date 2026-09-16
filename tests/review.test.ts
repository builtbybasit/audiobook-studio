import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// The book's review inbox: every decision waiting on a person, gathered from the six pages that
// each used to hold one small count of its own.
//
// Two properties are what make it worth having. It is *complete* — a decision that exists anywhere
// is listed here, with a link that lands on the row rather than the top of its page. And it is
// *settled by deciding*: accept the retake, clear the flag, dismiss the merge, retry the chapter,
// and the row is gone on the next read. A count that only ever goes up is a count nobody trusts.
import { test, expect, describe, beforeEach } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { reviewCount, reviewInbox, type DecisionGroup } from "@/views/review/inbox";

let castStore: ReturnType<typeof useCastStore>;
let demoStore: ReturnType<typeof useDemoStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  demoStore = useDemoStore();
  exportsStore = useExportsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  uiStore.toast = () => "test";
});

const group = (bookId: string, kind: string): DecisionGroup | undefined =>
  reviewInbox(bookId).find((g) => g.kind === kind);
const kinds = (bookId: string): string[] => reviewInbox(bookId).map((g) => g.kind);

describe("what the inbox gathers", () => {
  test("the listening scenario's flags and second takes are both in it, with the ledger's own links", () => {
    demoStore.applyScenario("stale-audio");
    const flagged = group("starforge", "flagged")!;
    const retakes = group("starforge", "retake")!;
    // the same segments the ledger's own chips count
    const segments = libraryStore
      .chaptersOf("starforge")
      .flatMap((c) => scriptsStore.segmentsOf("starforge", c.id));
    expect(flagged.items).toHaveLength(segments.filter((s) => s.flag).length);
    expect(retakes.items).toHaveLength(segments.filter((s) => s.candidate).length);
    expect(flagged.items.length).toBeGreaterThan(0);
    expect(retakes.items.length).toBeGreaterThan(0);

    // a jump lands on the row: the chapter, the ledger filter that shows it, and the segment
    expect(retakes.items[0].to).toMatchObject({
      path: "/book/starforge/narration",
      query: { filter: "review" },
    });
    const q = (retakes.items[0].to as { query: Record<string, string> }).query;
    expect(Number(q.ch)).toBeGreaterThan(0);
    expect(Number(q.seg)).toBeGreaterThan(0);
    expect(flagged.items[0].to).toMatchObject({ query: { filter: "flagged" } });
    // and it says which take is waiting against which, not just "a retake"
    expect(retakes.items[0].detail).toMatch(/take \d/i);
  });

  test("a part-way book brings its failed run, its unverified chunk and its undecided chapters together", () => {
    demoStore.applyScenario("resume-book");
    const all = kinds("cliche");
    expect(all).toContain("failed");
    expect(all).toContain("unverified");

    const failed = group("cliche", "failed")!;
    const chapters = libraryStore.chaptersOf("cliche");
    // every chapter still failed, and every build that stopped part-way
    expect(failed.items).toHaveLength(
      chapters.filter((c) => c.scripting === "failed").length +
        chapters.filter((c) => c.narration === "failed").length +
        exportsStore.exportsOf("cliche").filter((e) => e.status === "failed").length,
    );
    const broken = chapters.find((c) => c.narration === "failed")!;
    // a failed chapter's link opens the ledger on that chapter, already filtered to what failed
    expect(failed.items.find((d) => d.id === `failed:narration:${broken.id}`)!.to).toMatchObject({
      path: "/book/cliche/narration",
      query: { ch: String(broken.id), filter: "failed" },
    });
    // and it says what went wrong rather than "Job failed", which is only how a run signs off
    expect(failed.items[0].detail).not.toBe("Job failed");

    const unverified = group("cliche", "unverified")!;
    expect(unverified.items).toHaveLength(
      chapters.flatMap((c) => scriptsStore.segmentsOf("cliche", c.id)).filter((s) => s.fallback)
        .length,
    );
  });

  test("chapters with the same notice are one decision, because one verdict settles them all", () => {
    // the 212-chapter serial, with updates scattered through it: a row per kind of notice, not a
    // row per chapter, or the inbox would be longer than the book
    demoStore.applyScenario("import-serial");
    const contents = group("import-serial", "contents")!;
    const pending = libraryStore.noticeGroupsOf("import-serial").filter((g) => g.pending.length);
    expect(pending.length).toBeGreaterThan(1);
    expect(contents.items).toHaveLength(pending.length);
    expect(contents.items.length).toBeLessThan(pending.reduce((n, g) => n + g.pending.length, 0));
    // the link arrives with the contents review already narrowed to that kind of notice
    expect(contents.items[0].to).toMatchObject({
      path: "/book/import-serial/contents",
      query: { kind: pending[0].kind },
    });
  });

  test("an expression the script moved under is listed with the line it sits on", () => {
    demoStore.applyScenario("expressions");
    const issues = narrationStore.expressionIssues(
      "starforge",
      libraryStore.chaptersOf("starforge").map((c) => c.id),
    );
    expect(issues.length).toBeGreaterThan(0);
    const expressions = group("starforge", "expression")!;
    expect(expressions.items).toHaveLength(issues.length);
    // it is settled in the reader, on the line it is placed in
    expect(expressions.items[0].to).toMatchObject({
      path: "/book/starforge/scripting",
      query: { ch: String(issues[0].chId), seg: String(issues[0].segId) },
    });
  });

  test("broken work is listed first, and the rest follow the pipeline", () => {
    demoStore.applyScenario("resume-book");
    const all = kinds("cliche");
    expect(all[0]).toBe("failed");
    const order = [
      "failed",
      "contents",
      "unverified",
      "speaker",
      "merge",
      "expression",
      "flagged",
      "retake",
    ];
    expect(all).toEqual(order.filter((k) => all.includes(k)));
  });

  test("the count the badges show is the number of rows the page lists", () => {
    demoStore.applyScenario("stale-audio");
    expect(reviewCount("starforge")).toBe(
      reviewInbox("starforge").reduce((n, g) => n + g.items.length, 0),
    );
    expect(reviewInbox("starforge").every((g) => g.items.length > 0)).toBe(true);
  });
});

describe("deciding one empties its row", () => {
  test("accepting a retake and clearing a flag drop out of the list", () => {
    demoStore.applyScenario("stale-audio");
    const before = group("starforge", "retake")!.items.length;
    const row = group("starforge", "retake")!.items[0];
    const [, chId, segId] = row.id.split(":").map(Number);
    narrationStore.acceptTake("starforge", chId, segId);
    expect(group("starforge", "retake")?.items.length ?? 0).toBe(before - 1);

    const flag = group("starforge", "flagged")!.items[0];
    const [, fCh, fSeg] = flag.id.split(":").map(Number);
    const flagsBefore = group("starforge", "flagged")!.items.length;
    narrationStore.clearFlag("starforge", fCh, fSeg);
    expect(group("starforge", "flagged")?.items.length ?? 0).toBe(flagsBefore - 1);
  });

  test("a chapter that failed and was run again stops being a decision, however long its job history is", () => {
    demoStore.applyScenario("resume-book");
    const failed = libraryStore.chaptersOf("cliche").find((c) => c.narration === "failed")!;
    expect(
      group("cliche", "failed")!.items.some((d) => d.id === `failed:narration:${failed.id}`),
    ).toBe(true);
    const history = jobsStore.jobs.filter((j) => j.status === "failed").length;

    failed.narration = "done";
    // the failed job is still in the queue's history; the decision is not
    expect(jobsStore.jobs.filter((j) => j.status === "failed").length).toBe(history);
    expect(
      (group("cliche", "failed")?.items ?? []).some(
        (d) => d.id === `failed:narration:${failed.id}`,
      ),
    ).toBe(false);
  });

  test("a merge suggestion the user dismissed does not come back", () => {
    demoStore.applyScenario("resume-book");
    const suggestion = castStore.mergeSuggestions("cliche")[0];
    if (!suggestion) return;
    expect(group("cliche", "merge")!.items.some((d) => d.id === `merge:${suggestion.from}`)).toBe(
      true,
    );
    // what the Cast page's "keep this name" does
    const c = castStore.characters["cliche"]!.find((x) => x.name === suggestion.from)!;
    c.isNew = false;
    c.keep = true;
    expect(
      (group("cliche", "merge")?.items ?? []).some((d) => d.id === `merge:${suggestion.from}`),
    ).toBe(false);
  });
});

test("a book with nothing decided against it shows an empty inbox, not an empty page of zeroes", () => {
  demoStore.applyScenario("fresh-book");
  // nothing is scripted, so there are no clips, no new speakers and no failed runs to weigh up
  expect(group("drowned", "flagged")).toBeUndefined();
  expect(group("drowned", "retake")).toBeUndefined();
  expect(group("drowned", "failed")).toBeUndefined();
  expect(reviewInbox("drowned").every((g) => g.items.length > 0)).toBe(true);
});
