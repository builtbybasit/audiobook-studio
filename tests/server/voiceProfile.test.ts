// Filling a voice's profile: `POST /api/endpoints/:id/voices/:voice/profile`. Measured from the kept
// samples, written by a simulated scripting profile from those numbers, a page and the transcripts,
// priced into the ledger with no book, and a note for each step that could not run.
import { describe, expect, test } from "bun:test";

import type { Profile, Voice, VoiceProfileFill } from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SCRIPTING_MODEL } from "@/lib/providers";
import { DELIVERIES } from "@/lib/voiceProfile";
import type { FetchLike } from "@/services/http";
import { fakeScriptingProvider } from "~/providers/fake";
import type { AskInput } from "~/providers/scripting";
import { endpointRequests } from "~/usage/ledger";
import { cloneEndpoint, cloneForm, sampleFile } from "../support/cloning";
import { fakeMeter, type FakeMeter } from "../support/meter";
import { jsonBody, testApi } from "../support/server";

const simulated: Profile = {
  id: "sim",
  name: "Simulated",
  model: SIMULATED_SCRIPTING_MODEL,
  baseUrl: SIMULATED_BASE_URL,
  inPrice: 2,
  outPrice: 8,
  enabled: true,
  concurrency: 1,
  maxChars: 0,
  splitAt: "sentence",
  maxOutputTokens: 2000,
  maxRetries: 0,
  secPerChunk: 0.01,
  needsKey: false,
};

const mara: Voice = { id: "mara", label: "Mara", gender: "f" };
const URL_ = "https://example.test/mara";
const PAGE = "<h1>Mara</h1><p>A cold, calm captain.</p><ul><li>Hold the line.</li></ul>";

async function setup(o: { meter?: FakeMeter | null; samples?: boolean } = {}) {
  const meter = o.meter === null ? undefined : (o.meter ?? fakeMeter());
  const asked: AskInput[] = [];
  const fake = fakeScriptingProvider();
  const pageFetch: FetchLike = async () => new Response(PAGE);
  const api = testApi({
    scripting: { ...fake, ask: (input) => (asked.push(input), fake.ask!(input)) },
    meter,
    pageFetch,
  });
  const saved = await api.request("/api/endpoints", {
    ...jsonBody({
      endpoints: [cloneEndpoint({ voices: [mara] })],
      profiles: [simulated],
      credentials: [],
    }),
    method: "PUT",
  });
  expect(saved.status).toBe(200);
  if (o.samples !== false) {
    const kept = await api.request("/api/endpoints/fish/voices/mara/samples", {
      method: "POST",
      body: cloneForm({}, [sampleFile("a.wav")], ["Hold the line, all of you."]),
    });
    expect(kept.status).toBe(200);
  }
  const fill = (body: { url?: string; profile?: string }, voice = "mara") =>
    api.request<VoiceProfileFill & { error?: { message: string } }>(
      `/api/endpoints/fish/voices/${voice}/profile`,
      jsonBody(body),
    );
  return { api, meter, asked, fill };
}

describe("filling a voice profile", () => {
  test("measures the samples, has the model write from them, the page and transcripts, and prices it", async () => {
    const { api, meter, asked, fill } = await setup();
    const { status, body } = await fill({ url: URL_, profile: "sim" });

    expect(status).toBe(200);
    expect(body.notes).toEqual([]);
    expect(body.profile.measured).toEqual(meter!.measured);
    expect(meter!.calls).toHaveLength(1);
    expect(body.profile.delivery!.length).toBeGreaterThan(0);
    expect(body.profile.delivery!.every((d) => DELIVERIES.includes(d))).toBe(true);
    expect(body.profile.summary!.length).toBeLessThanOrEqual(120);
    expect(body.profile.source?.url).toBe(URL_);
    // the prompt carries the measured numbers as facts, the page and what the samples say
    expect(asked[0].user).toContain("measured, do not contradict");
    expect(asked[0].user).toContain("230 Hz");
    expect(asked[0].user).toContain("A cold, calm captain.");
    expect(asked[0].user).toContain("Hold the line, all of you.");

    const rows = endpointRequests(api.db, "scripting", "sim", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bookId: null, label: "Voice profile · Mara" });
  });

  test.each([
    ["no samples kept", { samples: false }, { url: URL_, profile: "sim" }, /No samples kept/],
    ["no uv", { meter: null }, { profile: "sim" }, /needs uv/],
    ["a page but no scripting endpoint", {}, { url: URL_ }, /Pick a scripting endpoint/],
    ["an unknown scripting endpoint", {}, { profile: "gone" }, /no scripting endpoint “gone”/],
  ] as const)("%s is a note, and the rest still fills", async (_, given, body, note) => {
    const { fill } = await setup(given);
    const answer = await fill(body);
    expect(answer.status).toBe(200);
    expect(answer.body.notes.join("\n")).toMatch(note);
    expect(Object.keys(answer.body.profile).length).toBeGreaterThan(0);
  });

  test("a missing voice is a 404, and a fill with nothing in it is refused with why", async () => {
    const { fill } = await setup({ samples: false });
    expect((await fill({}, "nobody")).status).toBe(404);
    const empty = await fill({});
    expect(empty.status).toBe(400);
    expect(empty.body.error?.message).toMatch(/No samples kept/);
  });
});
