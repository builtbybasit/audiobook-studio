// The book's review inbox: every decision waiting on a person, gathered from the six pages that
// each used to hold one small count of its own.
//
// Two properties are what make it worth having. It is *complete* — a decision that exists anywhere
// is listed here, with a link that lands on the row rather than the top of its page. And it is
// *settled by deciding*: accept the retake, clear the flag, dismiss the merge, retry the chapter,
// and the row is gone on the next read. A count that only ever goes up is a count nobody trusts.
//
// Each reads the demo library put into one of the Demo tools' situations, with the book read in
// whole — every scripted chapter, the cast, the audiobooks and the queue — as its pages would. The
// tests are grouped by situation, and a situation is applied once for the tests that only read it:
// each still reads it into a page of its own, and one that writes to the demo says so, so the next
// test is handed the situation afresh.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useQueryCache } from "@pinia/colada";
import { keys } from "@/queries/keys";

import { jobsService } from "@/services/jobs";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { reviewCount, reviewInbox, type DecisionGroup } from "@/views/review/inbox";
import { newSpeaker } from "@/lib/cast";
import type { Character } from "@/types";
import { demoServer, type DemoServer } from "./support/demoServer";
import { testPinia, type TestPinia } from "./support/pinia";

let demo: DemoServer;
let pinia: TestPinia;
let castStore: ReturnType<typeof useCastStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
/** The situation the demo is in with nothing written to it since, or null when a test wrote. */
let untouched: string | null = null;

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  demo = await demoServer();
});
beforeEach(() => {
  pinia = testPinia();
  castStore = useCastStore();
  exportsStore = useExportsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptsStore = useScriptsStore();
  useUiStore().toast = () => "test";
});
afterEach(() => pinia.stop());
afterAll(() => demo.hold());

/** The demo in situation `id`, and `bookId` read in whole. */
async function situated(id: string, bookId: string): Promise<void> {
  if (untouched !== id) {
    await demo.situate(id);
    // the runs a situation sets going would move the book on between one test's read and the
    // next's; held, it keeps still until the next situation
    await demo.hold();
    untouched = id;
  }
  const svc = libraryService();
  await libraryStore.loadBook(bookId);
  castStore._install(bookId, await svc.cast(bookId));
  useQueryCache().setQueryData(keys.exports(bookId), await svc.exports(bookId));
  useQueryCache().setQueryData(keys.jobs, await jobsService().list());
  for (const c of libraryStore.chaptersOf(bookId))
    if (c.scripting !== "none")
      scriptsStore._install(bookId, c.id, await svc.chapterScript(bookId, c.id));
}
/** Wait for a request the store sent on its own to be answered. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
}

const group = (bookId: string, kind: string): DecisionGroup | undefined =>
  reviewInbox(bookId).find((g) => g.kind === kind);
const kinds = (bookId: string): string[] => reviewInbox(bookId).map((g) => g.kind);

describe("a book with clips to listen to again", () => {
  beforeEach(() => situated("stale-audio", "starforge"));

  test("its flags and second takes are both in the inbox, with the ledger's own links", () => {
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

  test("a row names its chapter by reading number, which moves when an earlier chapter is skipped", () => {
    // the retake latest in the book, so there is a chapter before it to skip
    const row = group("starforge", "retake")!.items.reduce((a, b) =>
      b.chapterId! > a.chapterId! ? b : a,
    );
    const where = () => group("starforge", "retake")!.items.find((r) => r.id === row.id)!.where;
    const chapter = libraryStore.chapter("starforge", row.chapterId!)!;
    const n = libraryStore.numberOf("starforge", chapter.id)!;
    expect(row.where).toBe(`Ch ${n} · ${chapter.title}`);

    // skipping a chapter before it (on this page only) numbers it one lower
    const earlier = libraryStore
      .chaptersOf("starforge")
      .find((c) => c.id < chapter.id && !c.excluded)!;
    earlier.excluded = true;
    expect(where()).toBe(`Ch ${n - 1} · ${chapter.title}`);
    // and a skipped chapter has no number to give
    chapter.excluded = true;
    expect(where()).toBe(`Skipped · ${chapter.title}`);
  });

  test("the count the badges show is the number of rows the page lists", () => {
    expect(reviewCount("starforge")).toBe(
      reviewInbox("starforge").reduce((n, g) => n + g.items.length, 0),
    );
    expect(reviewInbox("starforge").every((g) => g.items.length > 0)).toBe(true);
  });

  test("accepting a retake and clearing a flag drop out of the list", async () => {
    untouched = null; // both are written to the demo
    const before = group("starforge", "retake")!.items.length;
    const row = group("starforge", "retake")!.items[0];
    const [, chId, segId] = row.id.split(":").map(Number);
    narrationStore.acceptTake("starforge", chId, segId);
    await until(() => (group("starforge", "retake")?.items.length ?? 0) < before);
    expect(group("starforge", "retake")?.items.length ?? 0).toBe(before - 1);

    const flag = group("starforge", "flagged")!.items[0];
    const [, fCh, fSeg] = flag.id.split(":").map(Number);
    const flagsBefore = group("starforge", "flagged")!.items.length;
    const cleared = narrationStore.clearFlag("starforge", fCh, fSeg);
    expect(group("starforge", "flagged")?.items.length ?? 0).toBe(flagsBefore - 1);
    await cleared;
  });
});

describe("a book part-way through", () => {
  // nothing here writes to the demo: what a page decides is decided on the page's own copy
  beforeEach(() => situated("resume-book", "cliche"));

  test("its failed run, its unverified chunk and its undecided chapters are brought together", () => {
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

  test("broken work is listed first, and the rest follow the pipeline", () => {
    const all = kinds("cliche");
    expect(all[0]).toBe("failed");
    const order = [
      "failed",
      "contents",
      "unverified",
      "sitetext",
      "speaker",
      "merge",
      "expression",
      "flagged",
      "retake",
    ];
    expect(all).toEqual(order.filter((k) => all.includes(k)));
  });

  test("a chapter that failed and was run again stops being a decision, however long its job history is", () => {
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
    // the scenario is seeded with one; without it this test would check nothing
    const suggestion = castStore.mergeSuggestions("cliche")[0];
    expect(suggestion).toBeDefined();
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

test("chapters with the same notice are one decision, because one verdict settles them all", async () => {
  // the 212-chapter serial, with updates scattered through it: a row per kind of notice, not a
  // row per chapter, or the inbox would be longer than the book
  await situated("import-serial", "import-serial");
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

test("an expression the script moved under is listed with the line it sits on", async () => {
  await situated("expressions", "starforge");
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

test("a book with nothing decided against it shows an empty inbox, not an empty page of zeroes", async () => {
  await situated("fresh-book", "drowned");
  // nothing is scripted, so there are no clips, no new speakers and no failed runs to weigh up
  expect(group("drowned", "flagged")).toBeUndefined();
  expect(group("drowned", "retake")).toBeUndefined();
  expect(group("drowned", "failed")).toBeUndefined();
  expect(reviewInbox("drowned").every((g) => g.items.length > 0)).toBe(true);
});

test("a long cast still has its alias, short form and contained name suggested, once each", () => {
  // the names are normalized once per read, not per pair; the pairs found must be the same
  const speaker = (name: string, c: Partial<Character> = {}): Character => ({
    ...newSpeaker(name, 0),
    isNew: false,
    ...c,
  });
  castStore._install("long", {
    characters: [
      speaker("Narrator"),
      ...Array.from({ length: 300 }, (_, i) => speaker(`Extra Number${i}`)),
      speaker("Ji Ning", { major: true, aliases: ["Little Ning!"] }),
      speaker("Shen Wuyan", { major: true }),
      speaker("little ning"),
      speaker("Ning"),
      speaker("Wuya", { isNew: true }),
      speaker("Wuyan", { keep: true }),
    ],
    lexicon: [],
  });
  expect(castStore.mergeSuggestions("long")).toEqual([
    { from: "little ning", into: "Ji Ning", reason: "“little ning” is a known alias of Ji Ning" },
    { from: "Ning", into: "Ji Ning", reason: "“Ning” looks like a short form of Ji Ning" },
    { from: "Wuya", into: "Shen Wuyan", reason: "“Wuya” is contained in Shen Wuyan" },
  ]);
});
