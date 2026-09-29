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

import { jobDiagnostics } from "@/lib/jobActivity";
import { backendServer } from "./support/backendServer";
import { openDemoBook } from "./support/demoBook";
import { epubFile, story } from "./support/epub";
import { testPinia, type TestPinia } from "./support/pinia";

let endpointsStore: ReturnType<typeof useEndpointsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let pinia: TestPinia;
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
    maxOutputTokens: 200,
  });
  endpointsStore.profiles = [p];
  scriptingStore.scriptSettings.profile = p.id;
  return p;
}
beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  const api = backendServer();
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

describe("the estimate", () => {
  beforeEach(async () => {
    await openDemoBook(pinia, book);
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
    endpointsStore.profiles[0].maxOutputTokens = 200;
    endpointsStore.profiles[0].inPrice = 0;
    endpointsStore.profiles[0].outPrice = 0;
    libraryStore.bookById(book)!.scriptBudget = 0;
    expect(scriptingStore.scriptEstimate(book, [1]).blockers).toEqual([]);
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
