// A scripting profile set to `simulated://`, run through the provider a real server runs with.
//
// What the profile promises is that nothing leaves the machine and nothing is billed, while the
// run still goes through the real queue, the real ledger and the real script store. So the chat
// provider here is handed a `fetch` that fails the test, and the run has to finish anyway.
import { describe, expect, test } from "bun:test";

import type { Book, Job, Profile, Segment } from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SCRIPTING_MODEL } from "@/lib/providers";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { fakeScriptingProvider } from "~/providers/fake";
import { ProviderError } from "~/providers/http";
import type { ScriptTarget } from "~/providers/scripting";
import { endpointRequests } from "~/usage/ledger";
import { epubFile } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

/** A fetch that fails the test: a simulated profile must never reach one. */
const noNetwork = (async (url: string) => {
  throw new Error(`a simulated profile sent a request to ${url}`);
}) as unknown as typeof fetch;

const simulated = (over: Partial<Profile> = {}): Profile => ({
  id: "sim",
  name: "Simulated",
  model: SIMULATED_SCRIPTING_MODEL,
  inPrice: 2,
  outPrice: 8,
  baseUrl: SIMULATED_BASE_URL,
  enabled: true,
  concurrency: 1,
  maxChars: 0,
  splitAt: "sentence",
  maxOutputTokens: 0,
  secPerChunk: 0,
  needsKey: false,
  ...over,
});

async function shelved(api: TestApi): Promise<string> {
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      chapters: [{ title: "One", paragraphs: ["The ledger lay open. “We are short,” said Mara."] }],
    }),
  );
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [], profiles: [simulated()], credentials: [] }),
    method: "PUT",
  });
  return body.book.id;
}

const target = (over: Partial<ScriptTarget> = {}): ScriptTarget => ({
  id: "sim",
  name: "Simulated",
  baseUrl: SIMULATED_BASE_URL,
  model: SIMULATED_SCRIPTING_MODEL,
  apiKey: null,
  needsKey: false,
  timeoutSec: 5,
  maxRetries: 0,
  cooldownSec: 0,
  maxOutputTokens: 0,
  ...over,
});

const input = (t: ScriptTarget | null, signal = new AbortController().signal) => ({
  title: "One",
  text: "“Come in,” said Mara.",
  signal,
  cast: [],
  target: t,
});

describe("a simulated scripting profile", () => {
  test("scripts a chapter through the queue without a request, and bills nothing", async () => {
    const api = testApi({ scripting: endpointScriptingProvider({ fetch: noNetwork }) });
    const id = await shelved(api);
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1], profile: "sim" }));
    await api.runner.idle();

    const { body } = await api.request<{ segments: Segment[] }>(
      `/api/books/${id}/chapters/1/script`,
    );
    expect(body.segments.find((s) => s.type === "dialogue")?.speaker).toBe("Mara");
    const { body: jobs } = await api.request<{ jobs: Job[] }>("/api/jobs");
    expect(jobs.jobs[0].label).toContain("Simulated");

    const [row] = endpointRequests(api.db, "scripting", "sim", 0);
    expect(row.status).toBe("done");
    expect(row.simulated).toBe(true);
  });

  test("answers the Test button without a request", async () => {
    const api = testApi({ scripting: endpointScriptingProvider({ fetch: noNetwork }) });
    await shelved(api);
    const { body } = await api.request<{ ok: boolean; ms: number }>(
      "/api/endpoints/test",
      jsonBody({ kind: "scripting", id: "sim" }),
    );
    expect(body).toMatchObject({ ok: true, ms: 0 });
  });

  test("a run with no profile is refused rather than sent anywhere", async () => {
    const provider = endpointScriptingProvider({ fetch: noNetwork });
    await expect(provider.script(input(null))).rejects.toThrow(/profile/i);
  });

  test("fails as often as its simulation says, as a server error worth retrying", async () => {
    const fake = (random: number) => fakeScriptingProvider({ random: () => random });
    const failing = target({ simulation: { latencyMs: 0, failRate: 0.25 } });
    const error = await fake(0.1)
      .script(input(failing))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
    expect((await fake(0.5).script(input(failing))).lines).not.toHaveLength(0);
  });

  test("takes as long as its simulation says, and stops when the run is cancelled", async () => {
    const slow = target({ simulation: { latencyMs: 40, failRate: 0 } });
    const started = performance.now();
    await fakeScriptingProvider().script(input(slow));
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);

    const cancel = new AbortController();
    const running = fakeScriptingProvider().script(
      input(target({ simulation: { latencyMs: 10_000, failRate: 0 } }), cancel.signal),
    );
    cancel.abort(new Error("cancelled"));
    await expect(running).rejects.toThrow("cancelled");
  });
});
