// Scripting endpoints and what a run is estimated at before it is queued. The run itself is the
// server's, and so is what each request is charged: see `tests/server/`. The estimate is worked out
// over a short book on a server of this file's own, the way a backend tab reads one.
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { newProfile, profileErrors, scriptParts } from "@/lib/scripting";
import type { Book, Job } from "@/types";

import { computed, nextTick } from "vue";
import { useQueryCache } from "@pinia/colada";
import { jobDiagnostics } from "@/lib/jobActivity";
import { keys } from "@/queries/keys";
import { useBookSpend } from "@/queries/spend";
import { useJobsStore } from "@/stores/jobs";
import { backendServer } from "./support/backendServer";
import { openDemoBook } from "./support/demoBook";
import { epubFile, story } from "./support/epub";
import { flush, testPinia, type TestPinia } from "./support/pinia";
import type { TestApi } from "./support/server";

let endpointsStore: ReturnType<typeof useEndpointsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let pinia: TestPinia;
let api: TestApi;
/** the book the estimates are worked out over: three chapters, the first longer than one chunk */
let book: string;

/** The one scripting endpoint each test runs against: no key, $1 in and $2 out per million. */
function useTestProfile() {
  const p = newProfile({
    id: "test",
    model: "test-model",
    needsKey: false,
    concurrency: 2,
    maxChars: 500,
    inPrice: 1,
    outPrice: 2,
    maxOutputTokens: 400,
  });
  endpointsStore.profiles = [p];
  scriptingStore.scriptSettings.profile = p.id;
  return p;
}
beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  api = backendServer();
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: story(4) })),
    }),
  );
  book = body.book.id;
  await api.request(`/api/books/${book}/confirm`, { method: "POST" });
});
beforeEach(() => {
  pinia = testPinia();
  useUiStore().toast = () => "test";
  endpointsStore = useEndpointsStore();
  libraryStore = useLibraryStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
});

const CHAPTER = "A sentence.  Another clause, and words.\n\n" + "abcdefghij".repeat(30);

test.each(["sentence", "clause", "word", "char"] as const)(
  "chunks cut at a %s boundary lose nothing and respect the chosen maximum",
  (splitAt) => {
    const parts = scriptParts(CHAPTER, newProfile({ model: "m", maxChars: 25, splitAt }));
    expect(parts.join("")).toBe(CHAPTER);
    expect(parts.filter((p) => p.length > 25 || p.length === 0)).toEqual([]);
  },
);

test("with no maximum, a chapter goes as one chunk", () => {
  expect(scriptParts(CHAPTER, newProfile({ model: "m", maxChars: 0 }))).toEqual([CHAPTER]);
});

test.each([-1, 0, 0.5, Infinity, NaN])("a concurrency of %p is refused", (concurrency) => {
  expect(profileErrors(newProfile({ model: "m", concurrency })).length).toBeGreaterThan(0);
});

test("a concurrency may be any positive whole number, however large, and the URL a base URL", () => {
  // not a slider artefact: a local server may take thousands at once
  expect(profileErrors(newProfile({ model: "m", concurrency: 2500 }))).toEqual([]);
  expect(
    profileErrors(newProfile({ model: "m", baseUrl: "https://example.com/v1/chat/completions" })),
  ).toContain("Use the base URL without /chat/completions.");
});

/** Read the book's spending as the app shell does, so a budget has something to be checked against. */
async function readSpend() {
  const jobsStore = useJobsStore();
  pinia.run(() => useBookSpend(book));
  while (!jobsStore.spendOf(book)) await flush();
}

describe("the estimate", () => {
  beforeEach(async () => {
    await openDemoBook(pinia, book);
    await readSpend();
    useTestProfile();
  });

  test("skips excluded and active chapters and uses endpoint-specific chunking", () => {
    libraryStore.chapter(book, 2)!.excluded = true;
    libraryStore.chapter(book, 3)!.scripting = "running";
    const estimate = scriptingStore.scriptEstimate(book, [1, 2, 3]);
    expect(estimate.chapters).toBe(1);
    expect(estimate.chunks).toBeGreaterThan(1);
    expect(estimate.chunks).toBe(
      scriptParts(scriptsStore.rawText(book, 1), endpointsStore.profiles[0]).length,
    );
  });

  test("a zero budget blocks paid work, and a paused endpoint blocks the run", () => {
    libraryStore.bookById(book)!.scriptBudget = 0;
    expect(scriptingStore.scriptEstimate(book, [1]).blockers).toContain(
      "Estimated cost exceeds the remaining book budget.",
    );
    libraryStore.bookById(book)!.scriptBudget = null;
    endpointsStore.profiles[0].enabled = false;
    expect(scriptingStore.scriptEstimate(book, [1]).blockers).toContain(
      "This endpoint is paused. Enable it or select another.",
    );
  });

  test("output limits block oversized chunks; a free endpoint fits a zero budget", () => {
    endpointsStore.profiles[0].maxOutputTokens = 1;
    expect(
      scriptingStore
        .scriptEstimate(book, [1])
        .blockers.some((x) => x.includes("output token limit")),
    ).toBe(true);
    endpointsStore.profiles[0].maxOutputTokens = 400;
    endpointsStore.profiles[0].inPrice = 0;
    endpointsStore.profiles[0].outPrice = 0;
    libraryStore.bookById(book)!.scriptBudget = 0;
    expect(scriptingStore.scriptEstimate(book, [1]).blockers).toEqual([]);
  });
});

// ---------- which endpoint a run goes to ----------

describe("the profile a run goes to", () => {
  const profile = (id: string, over: Parameters<typeof newProfile>[0] = {}) =>
    newProfile({ id, name: id, model: "m", needsKey: false, ...over });

  test("is the one picked while it exists, else the first that can run, else none", () => {
    expect(scriptingStore.runProfile).toBeUndefined();
    expect(scriptingStore.runBlockers).toEqual(["Add a scripting endpoint to run scripting."]);

    endpointsStore.profiles = [
      profile("paused", { enabled: false }),
      profile("broken", { model: "" }),
      profile("usable"),
    ];
    // nothing picked, or a pick that names nothing: the first profile that can take a run
    expect(scriptingStore.runProfile?.id).toBe("usable");
    scriptingStore.scriptSettings.profile = "gone";
    expect(scriptingStore.runProfile?.id).toBe("usable");
    // a pick that exists holds even while paused, and the blockers say why it cannot run
    scriptingStore.scriptSettings.profile = "paused";
    expect(scriptingStore.runProfile?.id).toBe("paused");
    expect(scriptingStore.runBlockers).toContain(
      "This endpoint is paused. Enable it or select another.",
    );

    endpointsStore.profiles = [profile("paused", { enabled: false })];
    scriptingStore.scriptSettings.profile = null;
    expect(scriptingStore.runProfile).toBeUndefined();
    expect(scriptingStore.runBlockers[0]).toContain("Every scripting endpoint is paused");
  });

  test("removing the picked profile leaves none picked, and Undo picks it again", () => {
    let undo: (() => void) | undefined;
    useUiStore().toast = (_msg: string, opts?: { undo?: () => void }) => {
      undo = opts?.undo;
      return "test";
    };
    endpointsStore.profiles = [profile("a"), profile("b")];
    scriptingStore.scriptSettings.profile = "b";
    endpointsStore.removeScriptProfile("b");
    expect(scriptingStore.scriptSettings.profile).toBeNull();
    expect(scriptingStore.runProfile?.id).toBe("a");
    undo!();
    expect(scriptingStore.scriptSettings.profile).toBe("b");
  });

  test("the pick is saved with the endpoints and read back, as a reload would", async () => {
    await endpointsStore.load(true);
    endpointsStore.profiles.push(profile("saved"));
    scriptingStore.scriptSettings.profile = "saved";
    await nextTick();
    await endpointsStore.flushWrites();
    endpointsStore._detach();

    // a new tab: the stores start from nothing and read the server
    pinia = testPinia();
    const reloaded = useScriptingStore();
    expect(reloaded.scriptSettings.profile).toBeNull();
    await useEndpointsStore().load(true);
    expect(reloaded.scriptSettings).toEqual({ profile: "saved" });
    useEndpointsStore()._detach();
    // leave the server as the other tests found it
    await api.request("/api/endpoints", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoints: [],
        profiles: [],
        credentials: [],
        script: { profile: null },
      }),
    });
  });
});

// ---------- what the Scripting page shows before everything is read ----------

describe("a selection not read yet", () => {
  beforeEach(async () => {
    await openDemoBook(pinia, book);
    await readSpend();
    useTestProfile();
  });

  test("is not priced as free: the estimate says it is reading, blocks the run, and prices it once read", async () => {
    const cache = pinia.run(() => useQueryCache());
    const text = cache.getQueryData(keys.chapterText(book, 1, "plain"));
    cache.remove(cache.getEntries({ key: keys.chapterText(book, 1, "plain"), exact: true })[0]);
    // what the page renders from: it must follow the text in when it lands
    const shown = computed(() => scriptingStore.scriptEstimate(book, [1]));
    expect(shown.value.reading).toBe(1);
    expect(shown.value.blockers).toContain("Reading the text of 1 chapter…");
    expect(scriptingStore.scriptPlan(book, [1]).requests).toBe(0);

    cache.setQueryData(keys.chapterText(book, 1, "plain"), text);
    expect(shown.value.reading).toBe(0);
    expect(shown.value.chunks).toBeGreaterThan(1);
    expect(shown.value.cost).toBeGreaterThan(0);
    expect(shown.value.blockers).toEqual([]);
  });

  test("a book with a cap whose spending is not read yet has an unknown amount left, not all of it", () => {
    const cache = pinia.run(() => useQueryCache());
    cache.remove(cache.getEntries({ key: keys.spend(book), exact: true })[0]);
    libraryStore.bookById(book)!.scriptBudget = 5;
    const estimate = scriptingStore.scriptEstimate(book, [1]);
    expect(Number.isNaN(estimate.remaining)).toBe(true);
    expect(estimate.blockers).toContain("Reading what this book has spent…");
    libraryStore.bookById(book)!.scriptBudget = null;
  });

  test("the budget left is the lower of the scripting budget and the book's overall cap", () => {
    const b = libraryStore.bookById(book)!;
    b.scriptBudget = 5;
    b.budget = { cap: 2, paused: false };
    expect(scriptingStore.scriptEstimate(book, [1]).remaining).toBe(2);
    b.budget = { cap: null, paused: false };
    expect(scriptingStore.scriptEstimate(book, [1]).remaining).toBe(5);
    b.scriptBudget = null;
    expect(scriptingStore.scriptEstimate(book, [1]).remaining).toBe(Infinity);
  });

  test("a chapter is a replacement by its own status, whether or not its script has been read", () => {
    const ch = libraryStore.chapter(book, 2)!;
    ch.scripting = "done";
    // nothing on this page has read chapter 2's script
    scriptsStore.segments = {};
    const plan = scriptingStore.scriptPlan(book, [1, 2]);
    expect([plan.fresh, plan.replace]).toEqual([1, 1]);
    ch.scripting = "none";
  });
});

// ---------- starting a run ----------

describe("a run started from a button", () => {
  beforeEach(async () => {
    await openDemoBook(pinia, book);
    await readSpend();
  });

  test("is refused, and says why, while the estimate has a blocker", async () => {
    const toasts: string[] = [];
    useUiStore().toast = (msg: string, opts?: { description?: string }) => {
      toasts.push(`${msg}: ${opts?.description ?? ""}`);
      return "test";
    };
    useTestProfile().enabled = false;
    const queued = async () =>
      (await api.request<{ jobs: unknown[] }>(`/api/jobs?bookId=${book}`)).body.jobs.length;
    const before = await queued();
    expect(await scriptingStore.startRun(book, [1])).toBe(false);
    expect(toasts.join("\n")).toContain("This endpoint is paused");
    expect(await queued()).toBe(before);
  });

  test("reads the chapters' text first, so a selection the page had not read yet can start", async () => {
    await endpointsStore.load(true);
    const p = newProfile({ id: "run", name: "Run", model: "m", needsKey: false, maxChars: 0 });
    endpointsStore.profiles.push(p);
    scriptingStore.scriptSettings.profile = p.id;
    const cache = pinia.run(() => useQueryCache());
    for (const e of cache.getEntries({ key: ["books", book, "text"] })) cache.remove(e);
    expect(await scriptingStore.startRun(book, [3], { quiet: true })).toBe(true);
    await api.runner.idle();
    endpointsStore._detach();
  });

  test("smaller chunks reach the server before the run that needs them, and the toast says every book is affected", async () => {
    const toasts: { msg: string; description?: string }[] = [];
    useUiStore().toast = (msg: string, opts?: { description?: string }) => {
      toasts.push({ msg, description: opts?.description });
      return "test";
    };
    await endpointsStore.load(true);
    const p = newProfile({ id: "chunks", name: "Chunky", model: "m", needsKey: false });
    endpointsStore.profiles.push(p);
    scriptingStore.scriptSettings.profile = p.id;
    await nextTick();
    await endpointsStore.flushWrites();
    const saved = () =>
      api.request<{ profiles: { id: string; maxChars: number }[] }>("/api/endpoints");
    expect((await saved()).body.profiles.find((x) => x.id === p.id)!.maxChars).toBe(6000);

    await scriptingStore.smallerChunks(book, 2);
    // the job was queued with the profile as the server held it at that moment
    const { jobs } = (
      await api.request<{
        jobs: { chapterId: number; scriptRun?: { profile: { maxChars: number } } }[];
      }>(`/api/jobs?bookId=${book}`)
    ).body;
    const run = jobs.filter((j) => j.chapterId === 2).at(-1)!;
    expect(run.scriptRun!.profile.maxChars).toBe(4000);
    expect((await saved()).body.profiles.find((x) => x.id === p.id)!.maxChars).toBe(4000);
    expect(toasts.at(-1)!.description).toContain("for every book it scripts");
    await api.runner.idle();
    endpointsStore._detach();
  });
});

test("settings round-trip retains endpoint limits and excludes unrecognized credential fields", () => {
  useTestProfile();
  const saved = endpointsStore.exportSettings();
  saved.profiles[0].concurrency = 2500;
  Object.assign(saved.profiles[0], { apiKey: "test-secret" });
  endpointsStore.importSettings(saved);
  expect(endpointsStore.profiles[0].concurrency).toBe(2500);
  expect(JSON.stringify(endpointsStore.exportSettings())).not.toContain("test-secret");
  const invalid = endpointsStore.exportSettings();
  invalid.profiles[0].concurrency = -1;
  expect(() => endpointsStore.importSettings(invalid)).toThrow("Invalid scripting endpoint");
  expect(endpointsStore.profiles[0].concurrency).toBe(2500);
});

// What the Queue's Copy diagnostics puts on the clipboard: the server keeps the log bounded
// (`tests/server/jobs.test.ts`), and this is the allowlist that keeps a run's connection off it.
test("copied diagnostics carry the job's log and never the connection it ran against", () => {
  const job: Job = {
    id: 1,
    kind: "scripting",
    bookId: "b",
    chapterId: null,
    label: "Test",
    status: "failed",
    progress: 0,
    queuedAt: 0,
    startedAt: null,
    finishedAt: null,
    cancelled: false,
    activity: [{ id: 1, at: 0, level: "error", message: "Gateway answered 500" }],
    droppedEvents: 3,
  };
  Object.assign(job, {
    scriptRun: { profile: { baseUrl: "https://private.invalid", apiKey: "sk-private" } },
  });
  const copied = JSON.parse(jobDiagnostics(job)) as Record<string, unknown>;
  expect(copied).toMatchObject({ jobId: 1, droppedEvents: 3, activity: job.activity });
  expect(JSON.stringify(copied)).not.toContain("private");
});
