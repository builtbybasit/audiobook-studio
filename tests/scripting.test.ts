// Scripting endpoints and what a run is estimated at before it is queued. The run itself is the
// server's, and so is what each request is charged: see `tests/server/`.
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { newProfile, profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import type { Job } from "@/types";

import { jobDiagnostics, logJob, MAX_JOB_EVENTS } from "@/lib/jobActivity";
import { demoServer } from "./support/demoServer";
import { openDemoBook } from "./support/demoBook";
import { testPinia, type TestPinia } from "./support/pinia";

let endpointsStore: ReturnType<typeof useEndpointsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let pinia: TestPinia;

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
  await demoServer();
});
beforeEach(() => {
  pinia = testPinia();
  useUiStore().toast = () => "test";
  endpointsStore = useEndpointsStore();
  libraryStore = useLibraryStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
});

test("chunk boundaries are lossless and respect the chosen maximum", () => {
  const text = "A sentence.  Another clause, and words.\n\n" + "abcdefghij".repeat(30);
  for (const mode of ["sentence", "clause", "word", "char"] as const) {
    const parts = scriptParts(text, newProfile({ model: "m", maxChars: 25, splitAt: mode }));
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => p.length <= 25 && p.length > 0)).toBe(true);
  }
  expect(scriptParts(text, newProfile({ model: "m", maxChars: 0 }))).toEqual([text]);
});
test("a concurrency must be a positive whole number, however large, and the URL a base URL", () => {
  for (const value of [-1, 0, 0.5, Infinity, NaN])
    expect(profileErrors(newProfile({ model: "m", concurrency: value })).length).toBeGreaterThan(0);
  // not a slider artefact: a local server may take thousands at once
  expect(profileErrors(newProfile({ model: "m", concurrency: 2500 }))).toEqual([]);
  expect(
    profileErrors(newProfile({ model: "m", baseUrl: "https://example.com/v1/chat/completions" })),
  ).toContain("Use the base URL without /chat/completions.");
});
test("prices input and output at their own rates, and charges the prompt once per request", () => {
  const p = useTestProfile(); // input $1, output $2 per million
  const text = "a".repeat(400);
  const t = tokenEstimate(text, p);
  expect(t.inputCost).toBeCloseTo((t.inputTokens * p.inPrice) / 1e6, 12);
  expect(t.outputCost).toBeCloseTo((t.outputTokens * p.outPrice) / 1e6, 12);
  expect(t.cost).toBeCloseTo(t.inputCost + t.outputCost, 12);
  // the same text sent in two requests carries the prompt twice
  expect(tokenEstimate(text.slice(0, 200), p).inputTokens * 2).toBeGreaterThan(t.inputTokens);
});

describe("the estimate", () => {
  beforeEach(async () => {
    await openDemoBook(pinia, "cliche");
    useTestProfile();
  });

  test("skips excluded and active chapters and uses endpoint-specific chunking", () => {
    libraryStore.chapter("cliche", 2)!.excluded = true;
    libraryStore.chapter("cliche", 3)!.scripting = "running";
    const estimate = scriptingStore.scriptEstimate("cliche", [1, 2, 3]);
    expect(estimate.chapters).toBe(1);
    expect(estimate.chunks).toBeGreaterThan(1);
    expect(estimate.chunks).toBe(
      scriptParts(scriptsStore.rawText("cliche", 1), endpointsStore.profiles[0]).length,
    );
  });

  test("a zero budget blocks paid work, and a paused endpoint blocks the run", () => {
    libraryStore.bookById("cliche")!.scriptBudget = 0;
    expect(scriptingStore.scriptEstimate("cliche", [1]).blockers).toContain(
      "Estimated cost exceeds the remaining book budget.",
    );
    libraryStore.bookById("cliche")!.scriptBudget = null;
    endpointsStore.profiles[0].enabled = false;
    expect(scriptingStore.scriptEstimate("cliche", [1]).blockers).toContain(
      "This endpoint is paused. Enable it or select another.",
    );
  });

  test("output limits block oversized chunks; a free endpoint fits a zero budget", () => {
    endpointsStore.profiles[0].maxOutputTokens = 1;
    expect(
      scriptingStore
        .scriptEstimate("cliche", [1])
        .blockers.some((x) => x.includes("output token limit")),
    ).toBe(true);
    endpointsStore.profiles[0].maxOutputTokens = 200;
    endpointsStore.profiles[0].inPrice = 0;
    endpointsStore.profiles[0].outPrice = 0;
    libraryStore.bookById("cliche")!.scriptBudget = 0;
    expect(scriptingStore.scriptEstimate("cliche", [1]).blockers).toEqual([]);
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

test("retained diagnostics stay bounded and omit connection snapshots and credentials", () => {
  const job: Job = {
    id: 1,
    kind: "scripting",
    bookId: "cliche",
    chapterId: null,
    label: "Test",
    status: "queued",
    progress: 0,
    queuedAt: 0,
    startedAt: null,
    finishedAt: null,
    cancelled: false,
  };
  for (let i = 0; i < MAX_JOB_EVENTS + 2; i++) logJob(job, `Event ${i}`);
  logJob(job, "Authorization: Bearer sk-examplecredential", "error", {
    apiKey: "private",
    inputTokens: 123,
  });
  Object.assign(job, { scriptRun: { profile: { baseUrl: "https://private.invalid" } } });
  const exported = jobDiagnostics(job);
  expect(job.activity).toHaveLength(MAX_JOB_EVENTS);
  expect(job.droppedEvents).toBe(3);
  expect(exported).not.toContain("private");
  expect(exported).not.toContain("examplecredential");
  expect(exported).toContain('"inputTokens": 123');
  expect(new Set(job.activity!.map((e) => e.id)).size).toBe(MAX_JOB_EVENTS);
});
