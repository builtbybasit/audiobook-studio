import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { newProfile, profileErrors, scriptParts, tokenEstimate } from "../src/lib/scripting";
import { useApp } from "../src/stores/app";
import { jobDiagnostics, logJob, MAX_JOB_EVENTS } from "../src/lib/jobActivity";

let callbacks = new Map<number, () => void>();
let clock = 1000;
let restore: (() => void)[] = [];
let app: ReturnType<typeof useApp>;
function tick(ms = 220) {
  clock += ms;
  const pending = [...callbacks]; // New intervals start on the next tick.
  for (const [id, fn] of pending) if (callbacks.has(id)) fn();
}
function finish() {
  for (let i = 0; i < 200 && callbacks.size; i++) tick(3000);
  expect(callbacks.size).toBe(0);
}
beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  app = useApp();
  app.jobs = [];
  app.toast = () => "test";
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
  app.profiles = [p];
  app.scriptSettings.profile = p.id;
  callbacks = new Map();
  clock = 1000;
  let seq = 0;
  restore = [
    spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
      const id = ++seq;
      callbacks.set(id, fn);
      return id;
    }) as typeof setInterval),
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      callbacks.delete(id);
    }) as typeof clearInterval),
    spyOn(Date, "now").mockImplementation(() => clock),
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((fn) => fn()));

test("chunk boundaries are lossless and respect the chosen maximum", () => {
  const text = "A sentence.  Another clause, and words.\n\n" + "abcdefghij".repeat(30);
  for (const mode of ["sentence", "clause", "word", "char"] as const) {
    const parts = scriptParts(text, newProfile({ model: "m", maxChars: 25, splitAt: mode }));
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => p.length <= 25 && p.length > 0)).toBe(true);
  }
  expect(scriptParts(text, newProfile({ model: "m", maxChars: 0 }))).toEqual([text]);
});
test("accepts 2,500 concurrency and rejects invalid endpoints and limits", () => {
  expect(profileErrors(newProfile({ model: "m", concurrency: 2500 }))).toEqual([]);
  for (const value of [-1, 0, 0.5, Infinity, NaN])
    expect(profileErrors(newProfile({ model: "m", concurrency: value })).length).toBeGreaterThan(0);
  expect(
    profileErrors(newProfile({ model: "m", baseUrl: "https://example.com/v1/chat/completions" })),
  ).toContain("Use the base URL without /chat/completions.");
});
test("calculates input/output separately and includes per-request prompt overhead", () => {
  const p = app.profiles[0];
  const text = "a".repeat(400);
  const t = tokenEstimate(text, p);
  expect(t.inputTokens).toBe(660);
  expect(t.outputTokens).toBe(115);
  expect(t.cost).toBeCloseTo(0.00089, 10);
  expect(tokenEstimate(text.slice(0, 200), p).inputTokens * 2).toBeGreaterThan(t.inputTokens);
});
test("estimate skips excluded and active chapters and uses endpoint-specific chunking", () => {
  app.chapter("cliche", 2)!.excluded = true;
  app.chapter("cliche", 3)!.scripting = "running";
  const estimate = app.scriptEstimate("cliche", [1, 2, 3]);
  expect(estimate.chapters).toBe(1);
  expect(estimate.chunks).toBe(scriptParts(app.rawText("cliche", 1), app.profiles[0]).length);
});
test("shares endpoint concurrency across books, orders chapters, and snapshots rates", () => {
  const estimate = app.scriptEstimate("cliche", [1]);
  app.runScripting("cliche", [1, 2]);
  app.runScripting("drowned", [1]);
  tick();
  expect(app.jobs.reduce((n, j) => n + (j.scriptRun?.active ?? 0), 0)).toBe(2);
  expect(app.jobs.find((j) => j.bookId === "cliche" && j.chapterId === 2)!.status).toBe("queued");
  app.profiles[0].inPrice = 999;
  app.profiles[0].model = "changed-model";
  finish();
  const job = app.jobs.find((j) => j.bookId === "cliche" && j.chapterId === 1)!;
  expect(job.scriptRun!.cost).toBeCloseTo(estimate.cost, 10);
  expect(job.scriptRun!.profile.model).toBe("test-model");
  expect(app.jobs.every((j) => j.status === "done")).toBe(true);
});
test("budget reservations throttle requests and spend survives cleared jobs", () => {
  const e = app.scriptEstimate("cliche", [1]);
  app.bookById("cliche")!.scriptBudget = e.cost + 0.0005;
  app.runScripting("cliche", [1]);
  while (callbacks.size) {
    tick(3000);
    expect(app.scriptSpent("cliche") + app.scriptReserved("cliche")).toBeLessThanOrEqual(
      app.bookById("cliche")!.scriptBudget! + 1e-9,
    );
  }
  expect(app.scriptSpent("cliche")).toBeCloseTo(e.cost, 10);
  app.clearFinished();
  expect(app.scriptSpent("cliche")).toBeCloseTo(e.cost, 10);
});
test("zero budget blocks paid work; paused endpoints block launch", () => {
  app.bookById("cliche")!.scriptBudget = 0;
  app.runScripting("cliche", [1]);
  expect(app.jobs).toHaveLength(0);
  app.bookById("cliche")!.scriptBudget = null;
  app.profiles[0].enabled = false;
  app.runScripting("cliche", [1]);
  expect(app.jobs).toHaveLength(0);
});
test("live pause drains current requests, resumes, and cancellation releases reservations", () => {
  app.runScripting("cliche", [1]);
  tick();
  app.profiles[0].enabled = false;
  tick(3000);
  expect(app.jobs[0].scriptRun!.active).toBe(0);
  const completed = app.jobs[0].scriptRun!.completed;
  tick(3000);
  expect(app.jobs[0].scriptRun!.completed).toBe(completed);
  app.profiles[0].enabled = true;
  tick();
  expect(app.jobs[0].scriptRun!.active).toBe(2);
  app.cancelJob(app.jobs[0].id);
  tick();
  expect(app.scriptReserved("cliche")).toBe(0);
  expect(callbacks.size).toBe(0);
});
test("partial fallback retry retains other segments and honors the same scheduler", () => {
  const segments = app.segmentsOf("cliche", 7);
  const fallback = segments.find((s) => s.fallback)!;
  const before = segments.filter((s) => s !== fallback).map((s) => s.text);
  app.retryChunk("cliche", 7, fallback.id);
  tick();
  expect(app.jobs[0].scriptRun!.active).toBeLessThanOrEqual(2);
  finish();
  const after = app.segmentsOf("cliche", 7);
  expect(before.every((text) => after.some((s) => s.text === text))).toBe(true);
  expect(after.some((s) => s.fallback)).toBe(false);
});

test("output limits block oversized chunks; free endpoints work with a zero budget", () => {
  app.profiles[0].maxOutputTokens = 1;
  expect(
    app.scriptEstimate("cliche", [1]).blockers.some((x) => x.includes("output token limit")),
  ).toBe(true);
  app.profiles[0].maxOutputTokens = 200;
  app.profiles[0].inPrice = 0;
  app.profiles[0].outPrice = 0;
  app.bookById("cliche")!.scriptBudget = 0;
  app.runScripting("cliche", [1]);
  finish();
  expect(app.jobs[0].status).toBe("done");
  expect(app.scriptSpent("cliche")).toBe(0);
});

test("settings round-trip retains endpoint limits and excludes unrecognized credential fields", () => {
  const saved = app.exportSettings();
  saved.profiles[0].concurrency = 2500;
  Object.assign(saved.profiles[0], { apiKey: "test-secret" });
  app.importSettings(saved);
  expect(app.profiles[0].concurrency).toBe(2500);
  expect(JSON.stringify(app.exportSettings())).not.toContain("test-secret");
  const invalid = app.exportSettings();
  invalid.profiles[0].concurrency = -1;
  expect(() => app.importSettings(invalid)).toThrow("Invalid scripting endpoint");
  expect(app.profiles[0].concurrency).toBe(2500);
});

test("a second run for the same book waits for the first batch", () => {
  app.runScripting("cliche", [1, 2]);
  app.runScripting("cliche", [3]);
  tick();
  expect(app.jobs[2].status).toBe("queued");
  expect(app.jobs[2].scriptRun!.active).toBe(0);
  finish();
  expect(app.jobs[2].startedAt!).toBeGreaterThanOrEqual(app.jobs[1].finishedAt!);
});

test("job activity records request attempts, usage and completion across a cooldown", () => {
  app.runScripting("cliche", [1]);
  const job = app.jobs[0];
  spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.5);
  tick();
  expect(job.activity!.some((e) => e.detail?.code === 429)).toBe(true);
  tick(12_000);
  expect(job.activity!.find((e) => e.message === "Request 1 started")?.detail?.attempt).toBe(2);
  finish();
  const completions = job.activity!.filter((e) => /^Request \d+ completed$/.test(e.message));
  expect(completions.length).toBe(job.scriptRun!.requests);
  expect(completions.reduce((n, e) => n + Number(e.detail?.inputTokens), 0)).toBe(
    job.scriptRun!.inputTokens,
  );
  expect(job.activity!.filter((e) => e.message === "Job started")).toHaveLength(1);
  expect(job.activity!.at(-1)!.message).toBe("Job done");
});

test("paused activity does not flood the log, and cancellation is recorded once", () => {
  app.runScripting("cliche", [1]);
  tick();
  app.profiles[0].enabled = false;
  tick(3000);
  const job = app.jobs[0];
  const count = job.activity!.length;
  for (let i = 0; i < 30; i++) tick();
  expect(job.activity).toHaveLength(count);
  expect(job.waitingReason).toBe("Endpoint is paused");
  app.cancelJob(job.id);
  app.cancelJob(job.id);
  tick();
  expect(job.activity!.filter((e) => e.message === "Cancellation requested")).toHaveLength(1);
  expect(job.activity!.at(-1)!.message).toBe("Job cancelled");
});

test("retained diagnostics stay bounded and omit connection snapshots and credentials", () => {
  const job = app.addJob("scripting", "cliche", "Test");
  for (let i = 0; i < MAX_JOB_EVENTS + 2; i++) logJob(job, `Event ${i}`);
  logJob(job, "Authorization: Bearer sk-examplecredential", "error", {
    apiKey: "private",
    inputTokens: 123,
  });
  Object.assign(job, { scriptRun: { profile: { baseUrl: "https://private.invalid" } } });
  const exported = jobDiagnostics(job);
  expect(job.activity).toHaveLength(MAX_JOB_EVENTS);
  expect(job.droppedEvents).toBe(4);
  expect(exported).not.toContain("private");
  expect(exported).not.toContain("examplecredential");
  expect(exported).toContain('"inputTokens": 123');
  expect(new Set(job.activity!.map((e) => e.id)).size).toBe(MAX_JOB_EVENTS);
});

test("export jobs record milestones and the completed artifact", () => {
  app.buildExport("starforge", [1], {
    title: "Test book",
    filename: "test-log",
    bitrate: 64,
  } as Parameters<typeof app.buildExport>[2]);
  finish();
  const job = app.jobs[0];
  expect(job.status).toBe("done");
  expect(job.activity!.some((e) => e.message === "Export 25% complete")).toBe(true);
  expect(job.activity!.find((e) => e.message === "Export ready")!.detail?.filename).toBe(
    "test-log.m4b",
  );
  expect(job.activity!.at(-1)!.message).toBe("Job done");
});
