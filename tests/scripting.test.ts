import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { newProfile, profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import { newPricing, uncachedInput } from "@/lib/pricing";

import { jobDiagnostics, logJob, MAX_JOB_EVENTS } from "@/lib/jobActivity";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";

let callbacks = new Map<number, () => void>();
let clock = 1000;
let restore: (() => void)[] = [];
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;
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
  endpointsStore = useEndpointsStore();
  exportsStore = useExportsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  jobsStore.jobs = [];
  uiStore.toast = () => "test";
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
  const p = endpointsStore.profiles[0];
  const text = "a".repeat(400);
  const t = tokenEstimate(text, p);
  expect(t.inputTokens).toBe(660);
  expect(t.outputTokens).toBe(115);
  expect(t.cost).toBeCloseTo(0.00089, 10);
  expect(tokenEstimate(text.slice(0, 200), p).inputTokens * 2).toBeGreaterThan(t.inputTokens);
});
test("estimate skips excluded and active chapters and uses endpoint-specific chunking", () => {
  libraryStore.chapter("cliche", 2)!.excluded = true;
  libraryStore.chapter("cliche", 3)!.scripting = "running";
  const estimate = scriptingStore.scriptEstimate("cliche", [1, 2, 3]);
  expect(estimate.chapters).toBe(1);
  expect(estimate.chunks).toBe(
    scriptParts(scriptsStore.rawText("cliche", 1), endpointsStore.profiles[0]).length,
  );
});
test("shares endpoint concurrency across books, orders chapters, and snapshots rates", () => {
  const estimate = scriptingStore.scriptEstimate("cliche", [1]);
  scriptingStore.runScripting("cliche", [1, 2]);
  scriptingStore.runScripting("drowned", [1]);
  tick();
  expect(jobsStore.jobs.reduce((n, j) => n + (j.scriptRun?.active ?? 0), 0)).toBe(2);
  expect(jobsStore.jobs.find((j) => j.bookId === "cliche" && j.chapterId === 2)!.status).toBe(
    "queued",
  );
  endpointsStore.profiles[0].inPrice = 999;
  endpointsStore.profiles[0].model = "changed-model";
  finish();
  const job = jobsStore.jobs.find((j) => j.bookId === "cliche" && j.chapterId === 1)!;
  expect(job.scriptRun!.cost).toBeCloseTo(estimate.cost, 10);
  expect(job.scriptRun!.profile.model).toBe("test-model");
  expect(jobsStore.jobs.every((j) => j.status === "done")).toBe(true);
});
test("budget reservations throttle requests and spend survives cleared jobs", () => {
  const e = scriptingStore.scriptEstimate("cliche", [1]);
  libraryStore.bookById("cliche")!.scriptBudget = e.cost + 0.0005;
  scriptingStore.runScripting("cliche", [1]);
  while (callbacks.size) {
    tick(3000);
    expect(
      jobsStore.scriptSpent("cliche") + jobsStore.scriptReserved("cliche"),
    ).toBeLessThanOrEqual(libraryStore.bookById("cliche")!.scriptBudget! + 1e-9);
  }
  expect(jobsStore.scriptSpent("cliche")).toBeCloseTo(e.cost, 10);
  jobsStore.clearFinished();
  expect(jobsStore.scriptSpent("cliche")).toBeCloseTo(e.cost, 10);
});
test("zero budget blocks paid work; paused endpoints block launch", () => {
  libraryStore.bookById("cliche")!.scriptBudget = 0;
  scriptingStore.runScripting("cliche", [1]);
  expect(jobsStore.jobs).toHaveLength(0);
  libraryStore.bookById("cliche")!.scriptBudget = null;
  endpointsStore.profiles[0].enabled = false;
  scriptingStore.runScripting("cliche", [1]);
  expect(jobsStore.jobs).toHaveLength(0);
});
test("live pause drains current requests, resumes, and cancellation releases reservations", () => {
  scriptingStore.runScripting("cliche", [1]);
  tick();
  endpointsStore.profiles[0].enabled = false;
  tick(3000);
  expect(jobsStore.jobs[0].scriptRun!.active).toBe(0);
  const completed = jobsStore.jobs[0].scriptRun!.completed;
  tick(3000);
  expect(jobsStore.jobs[0].scriptRun!.completed).toBe(completed);
  endpointsStore.profiles[0].enabled = true;
  tick();
  expect(jobsStore.jobs[0].scriptRun!.active).toBe(2);
  jobsStore.cancelJob(jobsStore.jobs[0].id);
  tick();
  expect(jobsStore.scriptReserved("cliche")).toBe(0);
  expect(callbacks.size).toBe(0);
});
test("partial fallback retry retains other segments and honors the same scheduler", () => {
  const segments = scriptsStore.segmentsOf("cliche", 7);
  const fallback = segments.find((s) => s.fallback)!;
  const before = segments.filter((s) => s !== fallback).map((s) => s.text);
  scriptingStore.retryChunk("cliche", 7, fallback.id);
  tick();
  expect(jobsStore.jobs[0].scriptRun!.active).toBeLessThanOrEqual(2);
  finish();
  const after = scriptsStore.segmentsOf("cliche", 7);
  expect(before.every((text) => after.some((s) => s.text === text))).toBe(true);
  expect(after.some((s) => s.fallback)).toBe(false);
});

test("output limits block oversized chunks; free endpoints work with a zero budget", () => {
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
  scriptingStore.runScripting("cliche", [1]);
  finish();
  expect(jobsStore.jobs[0].status).toBe("done");
  expect(jobsStore.scriptSpent("cliche")).toBe(0);
});

test("settings round-trip retains endpoint limits and excludes unrecognized credential fields", () => {
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

test("a second run for the same book waits for the first batch", () => {
  scriptingStore.runScripting("cliche", [1, 2]);
  scriptingStore.runScripting("cliche", [3]);
  tick();
  expect(jobsStore.jobs[2].status).toBe("queued");
  expect(jobsStore.jobs[2].scriptRun!.active).toBe(0);
  finish();
  expect(jobsStore.jobs[2].startedAt!).toBeGreaterThanOrEqual(jobsStore.jobs[1].finishedAt!);
});

test("job activity records request attempts, usage and completion across a cooldown", () => {
  scriptingStore.runScripting("cliche", [1]);
  const job = jobsStore.jobs[0];
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
  scriptingStore.runScripting("cliche", [1]);
  tick();
  endpointsStore.profiles[0].enabled = false;
  tick(3000);
  const job = jobsStore.jobs[0];
  const count = job.activity!.length;
  for (let i = 0; i < 30; i++) tick();
  expect(job.activity).toHaveLength(count);
  expect(job.waitingReason).toBe("Endpoint is paused");
  jobsStore.cancelJob(job.id);
  jobsStore.cancelJob(job.id);
  tick();
  expect(job.activity!.filter((e) => e.message === "Cancellation requested")).toHaveLength(1);
  expect(job.activity!.at(-1)!.message).toBe("Job cancelled");
});

test("retained diagnostics stay bounded and omit connection snapshots and credentials", () => {
  const job = jobsStore.addJob("scripting", "cliche", "Test");
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

test("export jobs record milestones and the completed artifact", async () => {
  await exportsStore.buildExport("starforge", [2, 3, 4, 5, 6], {
    ...DEFAULT_EXPORT_SETTINGS,
    title: "Test book",
    filename: "test-log",
    bitrate: 64,
  });
  finish();
  const job = jobsStore.jobs[0];
  expect(job.status).toBe("done");
  expect(job.kind).toBe("export");
  expect(job.activity!.some((e) => e.message.startsWith("25%"))).toBe(true);
  expect(job.activity!.find((e) => e.message === "Export ready")!.detail?.files).toBe(1);
  expect(exportsStore.exports[0].filename).toBe("test-log.m4b");
  expect(exportsStore.exports[0].status).toBe("done");
  expect(job.activity!.at(-1)!.message).toBe("Job done");
});

// ---------- pricing a run ----------

test("a completed request keeps the rates it was charged at when the card changes afterwards", () => {
  const p = endpointsStore.profiles[0];
  p.pricing = newPricing({ timezone: "UTC" });
  scriptingStore.runScripting("cliche", [1]);
  finish();
  const usage = jobsStore.scriptUsage.filter((u) => u.bookId === "cliche");
  expect(usage.length).toBeGreaterThan(0);
  const spent = jobsStore.scriptSpent("cliche");
  const receipt = usage[0].priced!;
  expect(receipt.rates.input.rate).toBe(1);
  expect(receipt.at).toBeGreaterThan(0);
  expect(receipt.rule).toContain("completed");

  // triple the rates and add a promotion long after the fact
  p.inPrice = 3;
  p.outPrice = 6;
  p.pricing.promotions = [
    { id: "x", label: "X", from: null, until: null, scope: ["model"], percent: 90 },
  ];
  expect(jobsStore.scriptSpent("cliche")).toBeCloseTo(spent, 12);
  expect(usage[0].priced!.rates.input.rate).toBe(1);
  expect(usage[0].priced!.total).toBeCloseTo(receipt.total!, 12);
});

test("usage is recorded as a total with the cached part inside it, never added on top", () => {
  const p = endpointsStore.profiles[0];
  p.pricing = newPricing({ timezone: "UTC", cachedInput: 0.25 });
  scriptingStore.runScripting("cliche", [1]);
  finish();
  for (const u of jobsStore.scriptUsage) {
    const usage = u.priced!.usage;
    const lines = u.priced!.lines;
    const inputLines = lines
      .filter((l) => l.component !== "output")
      .reduce((n, l) => n + l.tokens, 0);
    expect(inputLines).toBe(usage.inputTokens);
    expect(uncachedInput(usage)).toBeGreaterThanOrEqual(0);
    // and the charge is the sum of its own lines
    expect(u.priced!.calculated).toBeCloseTo(
      lines.reduce((n, l) => n + (l.amount ?? 0), 0),
      12,
    );
  }
});

test("each request of one run is priced at its own instant across a rate boundary", () => {
  const p = endpointsStore.profiles[0];
  // an off-peak window that ends a moment after the run starts, read in UTC from the fake clock
  const start = new Date(clock);
  const endsAt = (start.getUTCHours() * 60 + start.getUTCMinutes() + 1) % 1440;
  p.pricing = newPricing({
    timezone: "UTC",
    windows: [
      {
        id: "n",
        label: "Off-peak",
        days: [],
        from: (endsAt - 300 + 1440) % 1440,
        to: endsAt,
        percent: 50,
      },
    ],
  });
  p.concurrency = 1; // one at a time, so the run spans the boundary rather than beating it
  p.maxChars = 400;
  p.secPerChunk = 100; // 10s of simulated time each, so the run outlasts the minute
  scriptingStore.runScripting("cliche", [1]);
  finish();
  const rates = jobsStore.scriptUsage.map((u) => u.priced!.rates.input.rate);
  expect(rates.length).toBeGreaterThan(1);
  // the batch's starting price was not applied to every request
  expect(new Set(rates).size).toBeGreaterThan(1);
  expect(rates).toContain(0.5);
  expect(rates).toContain(1);
});

test("a run reconciles its estimate against what the reported usage actually cost", () => {
  scriptingStore.runScripting("cliche", [1]);
  finish();
  const job = jobsStore.jobs.find((j) => j.scriptRun)!;
  expect(job.scriptRun!.estimated).toBeGreaterThan(0);
  const line = job.activity!.find((e) => e.message.startsWith("Estimate reconciled"))!;
  expect(line).toBeDefined();
  expect(line.detail!.estimatedUSD).toBe(job.scriptRun!.estimated!);
  expect(line.detail!.chargedUSD).toBe(job.scriptRun!.cost);
  expect(String(line.detail!.cacheShare)).toMatch(/%$/);
  // the reconciliation is bookkeeping, not a second charge
  expect(jobsStore.scriptSpent("cliche")).toBeCloseTo(job.scriptRun!.cost, 12);
});

test("a provider that reports no cache detail is recorded as unknown, not as a miss", () => {
  const p = endpointsStore.profiles[0];
  p.baseUrl = "http://localhost:8000/v1"; // a small server that reports totals only
  p.pricing = newPricing({ timezone: "UTC", cachedInput: 0.25 });
  scriptingStore.runScripting("cliche", [1]);
  finish();
  const receipts = jobsStore.scriptUsage.map((u) => u.priced!);
  expect(receipts.length).toBeGreaterThan(0);
  for (const r of receipts) {
    expect(r.usage.cachedInput).toBeNull();
    expect(r.basis).toBe("estimated");
    expect(r.unknowns.join(" ")).toContain("not reported");
    // the whole input is charged at the ordinary rate — the conservative reading
    expect(r.lines.find((l) => l.component === "input")!.rate).toBe(1);
    expect(r.lines.some((l) => l.component === "cachedInput")).toBe(false);
  }
  const job = jobsStore.jobs.find((j) => j.scriptRun)!;
  expect(job.scriptRun!.cacheUnreported).toBe(job.scriptRun!.requests);
  expect(job.scriptRun!.cachedInput).toBe(0);
});

test("a provider that reports its own charge is recorded as such, with ours kept beside it", () => {
  const p = endpointsStore.profiles[0];
  p.name = "DeepSeek";
  p.pricing = newPricing({ timezone: "UTC", cachedInput: 0.1 });
  scriptingStore.runScripting("cliche", [1]);
  finish();
  const r = jobsStore.scriptUsage[0].priced!;
  expect(r.basis).toBe("provider-reported");
  expect(r.reported).not.toBeNull();
  expect(r.calculated).not.toBeNull();
  expect(r.total).toBe(r.reported);
  expect(r.total).not.toBeCloseTo(r.calculated!, 12);
});
