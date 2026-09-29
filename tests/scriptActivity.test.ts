// What the Scripting page says about a profile, read off its requests in the server's ledger: the
// health dot, the activity figures and the estimate's observed cache rate (`src/lib/scriptActivity.ts`,
// `src/queries/scriptActivity.ts`).
import { describe, expect, test } from "bun:test";

import { recentCacheRate, scriptTelemetry, scriptUsageTotals } from "@/lib/scriptActivity";
import { newProfile, scriptingHealth, unusedTelemetry } from "@/lib/scripting";
import { useScriptActivity } from "@/queries/scriptActivity";
import { keyInPlace } from "@/services/endpointSettings";
import { useEndpointsStore } from "@/stores/endpoints";
import type { PricedRequest, RequestRecord, TokenUsage } from "@/types";
import { demoServer } from "./support/demoServer";
import { flush, testPinia } from "./support/pinia";

const profile = newProfile({
  id: "p",
  model: "m-1",
  baseUrl: "https://llm.test/v1",
  needsKey: false,
  cooldownSec: 20,
});

let n = 0;
/** One settled scripting request on `profile`, finished at `at`. */
function row(at: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: `r${n++}`,
    endpointId: profile.id,
    kind: "scripting",
    bookId: "b",
    chapterId: 1,
    label: "Script · ch 1",
    status: "done",
    attempts: 1,
    queuedAt: at - 1000,
    startedAt: at - 1000,
    finishedAt: at,
    queueMs: 0,
    responseMs: 1000,
    usage: {},
    cost: 0,
    costBasis: "calculated",
    simulated: false,
    ...over,
  };
}

const rateLimited = (at: number, over: Partial<RequestRecord> = {}): RequestRecord =>
  row(at, {
    status: "failed",
    rateLimited: true,
    chapterId: 3,
    error: { code: 429, message: "Rate limited", body: "{}", at },
    ...over,
  });

/** A receipt that only says what the provider reported; all the cache rate reads. */
const receipt = (inputTokens: number, cachedInput: number | null): PricedRequest =>
  ({
    usage: {
      inputTokens,
      cachedInput,
      cacheWrite: null,
      outputTokens: 10,
      format: "plain",
      problems: [],
    } satisfies TokenUsage,
  }) as unknown as PricedRequest;

/** Newest first, as the server sends them. */
const newestFirst = (rows: RequestRecord[]) =>
  [...rows].sort((a, b) => b.finishedAt! - a.finishedAt!);

describe("a profile's telemetry from its ledger rows", () => {
  test("a profile nothing has been sent to reads as unused, and so does one with work still out", () => {
    expect(scriptTelemetry([], profile)).toEqual(unusedTelemetry());
    const out = [row(1000, { status: "running" }), row(2000, { status: "queued" })];
    const telemetry = scriptTelemetry(out, profile);
    expect(telemetry).toEqual(unusedTelemetry());
    expect(scriptingHealth(profile, telemetry, false, 3000).label).toBe("Not used yet");
  });

  test("counts what completed, failed and was refused, and keeps the latest error on the profile", () => {
    const rows = newestFirst([
      row(1000, { responseMs: 800 }),
      row(2000, { responseMs: 1200, rateLimited: true }),
      row(3000, { status: "failed", error: { code: 500, message: "Boom", body: "x", at: 3000 } }),
      rateLimited(4000),
    ]);
    const t = scriptTelemetry(rows, profile);
    expect(t.completed).toBe(2);
    expect(t.failures).toBe(2);
    // a request that met a 429 and went through on a retry was still rate limited
    expect(t.rateLimits).toBe(2);
    expect(t.lastSuccess).toBe(2000);
    expect(t.history).toEqual([
      { at: 1000, ms: 800, ok: true },
      { at: 2000, ms: 1200, ok: true },
      { at: 3000, ms: 1000, ok: false },
      { at: 4000, ms: 1000, ok: false },
    ]);
    expect(t.lastError).toEqual({
      code: 429,
      message: "Rate limited",
      body: "{}",
      at: 4000,
      bookId: "b",
      chapterId: 3,
      model: "m-1",
      baseUrl: "https://llm.test/v1",
    });
  });

  test("a rate limit that was the last word cools the profile down for as long as it was asked", () => {
    const rows = newestFirst([row(1000), rateLimited(5000)]);
    // the profile's own cooldown when the provider named none
    const t = scriptTelemetry(rows, profile);
    expect(t.backoffUntil).toBe(5000 + 20_000);
    expect(scriptingHealth(profile, t, false, 10_000)).toEqual({
      label: "Retry in 15s",
      tone: "warn",
    });
    expect(scriptingHealth(profile, t, false, 30_000).label).toBe("Awaiting retry");
    // and the provider's Retry-After when it named one
    const named = newestFirst([
      rateLimited(5000, {
        error: { code: 429, message: "Rate limited", body: "", at: 5000, retryAfter: 3 },
      }),
    ]);
    expect(scriptTelemetry(named, profile).backoffUntil).toBe(8000);
  });

  test("a request that went through after the failure leaves no cooldown, and reads as recovered", () => {
    const t = scriptTelemetry(newestFirst([rateLimited(1000), row(2000)]), profile);
    expect(t.backoffUntil).toBe(0);
    expect(t.lastError?.at).toBe(1000);
    expect(scriptingHealth(profile, t, false, 2500).label).toBe("Recovered");
  });

  test("the latency history keeps the latest thirty requests, oldest first", () => {
    const rows = newestFirst(Array.from({ length: 45 }, (_, i) => row((i + 1) * 1000)));
    const { history, completed } = scriptTelemetry(rows, profile);
    expect(completed).toBe(45);
    expect(history).toHaveLength(30);
    expect(history[0].at).toBe(16_000);
    expect(history.at(-1)!.at).toBe(45_000);
  });
});

describe("a profile's usage from its ledger rows", () => {
  test("totals the tokens and the cost of every row, a failure's included", () => {
    const rows = [
      row(1000, { usage: { inputTokens: 100, outputTokens: 40 }, cost: 0.25 }),
      row(2000, { usage: { inputTokens: 50, outputTokens: 10 }, cost: 0.5, status: "failed" }),
      rateLimited(3000),
    ];
    expect(scriptUsageTotals(rows)).toEqual({ input: 150, output: 50, cost: 0.75 });
  });

  test("reads the cache rate off recent receipts that reported one, and none when none did", () => {
    expect(recentCacheRate([row(1000), row(2000, { priced: receipt(100, null) })])).toBeNull();
    const rows = newestFirst([
      row(1000, { priced: receipt(100, 80) }),
      row(2000, { priced: receipt(100, null) }),
      row(3000, { priced: receipt(300, 0) }),
    ]);
    expect(recentCacheRate(rows)).toEqual({ hitRate: 80 / 400, samples: 2 });
  });

  test("only the latest forty priced requests are asked about", () => {
    const rows = newestFirst([
      // an old run that had everything cached, past the window
      ...Array.from({ length: 10 }, (_, i) => row(i + 1, { priced: receipt(100, 100) })),
      ...Array.from({ length: 40 }, (_, i) => row(1000 + i, { priced: receipt(100, 0) })),
    ]);
    expect(recentCacheRate(rows)).toEqual({ hitRate: 0, samples: 40 });
  });
});

describe("over the demo library", () => {
  test("a scripting profile the demo puts in a 429 cooldown reads as cooling down, with its failures", async () => {
    Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
    const server = await demoServer();
    const pinia = testPinia();
    const endpointsStore = useEndpointsStore();
    await endpointsStore.load(true);
    const activity = pinia.run(() => useScriptActivity());
    const health = (id: string) => {
      const p = endpointsStore.profiles.find((x) => x.id === id)!;
      return scriptingHealth(p, scriptTelemetry(activity.rowsOf(id), p), keyInPlace(p), Date.now());
    };
    await flush();
    await flush();
    // the seeded demo has sent nothing to any of them yet
    const ids = endpointsStore.profiles.map((p) => p.id);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) expect(health(id).label).toBe("Not used yet");

    await server.situate("scripting-failed");
    await activity.refetch();
    // the profile the situation put in trouble: the first one enabled
    const p = endpointsStore.profiles.find((x) => x.enabled)!;
    const t = scriptTelemetry(activity.rowsOf(p.id), p);
    expect(t).toMatchObject({ completed: 0, failures: 2, rateLimits: 1 });
    expect(t.lastError).toMatchObject({ code: 429, bookId: "drowned", chapterId: 3 });
    expect(t.backoffUntil).toBeGreaterThan(Date.now());
    expect(health(p.id)).toMatchObject({
      label: expect.stringMatching(/^Retry in \d+s$/),
      tone: "warn",
    });
    // and the profiles it left alone are still unused
    for (const id of ids.filter((id) => id !== p.id)) expect(health(id).label).toBe("Not used yet");
    pinia.stop();
  });
});
