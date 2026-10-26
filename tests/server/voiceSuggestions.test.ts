// `POST /api/books/:id/voice-suggestions`: the scripting model's voice picks for named speakers,
// held to each speaker's candidates (enabled endpoints, their gender) and priced into the ledger.
import { describe, expect, test } from "bun:test";

import type { Character, Gender, Profile, VoiceSuggestions } from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SCRIPTING_MODEL } from "@/lib/providers";
import { checkedPicks } from "~/cast/suggest";
import { endpointRequests } from "~/usage/ledger";
import { line } from "../support/epub";
import { jsonBody, speechEndpoint, testApi, voicedBook, type TestApi } from "../support/server";

const simulated: Profile = {
  id: "sim",
  name: "Simulated",
  model: SIMULATED_SCRIPTING_MODEL,
  baseUrl: SIMULATED_BASE_URL,
  inPrice: 0,
  outPrice: 0,
  enabled: true,
  concurrency: 1,
  maxChars: 0,
  splitAt: "sentence",
  maxOutputTokens: 4000,
  maxRetries: 0,
  secPerChunk: 0.01,
  needsKey: false,
};

const studio = speechEndpoint({
  voices: [
    { id: "ash", gender: "m", label: "Ash" },
    { id: "bea", gender: "f", label: "Bea" },
    { id: "cy", gender: "m", label: "Cy" },
    { id: "dee", gender: "f", label: "Dee" },
  ],
});
const paused = speechEndpoint({
  id: "off",
  name: "Paused",
  enabled: false,
  voices: [{ id: "zed", gender: "f", label: "Zed" }],
});

/** Mara (f) and Tom (m), every speaker on studio/ash, and the simulated scripting profile. */
async function setup(): Promise<{ api: TestApi; id: string }> {
  const api = testApi();
  const id = await voicedBook(api, {
    endpoints: [studio, paused],
    paragraphs: [line("One"), line("Two", "Tom")],
    voiceOf: "studio/ash",
  });
  await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [studio, paused], profiles: [simulated], credentials: [] }),
    method: "PUT",
  });
  const { body } = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  const genders: Record<string, Gender> = { Mara: "f", Tom: "m" };
  for (const c of body.characters.filter((c) => genders[c.name]))
    await api.request(`/api/books/${id}/characters/${c.name}`, {
      ...jsonBody({ ...c, gender: genders[c.name] }),
      method: "PUT",
    });
  return { api, id };
}

const ask = (api: TestApi, id: string, body: unknown) =>
  api.request<VoiceSuggestions & { error?: { message: string } }>(
    `/api/books/${id}/voice-suggestions`,
    jsonBody(body),
  );

describe("voice suggestions", () => {
  test("come only from enabled voices of the speaker's gender, priced into the book's ledger", async () => {
    const { api, id } = await setup();
    const { status, body } = await ask(api, id, { profile: "sim", speakers: ["Mara", "Tom"] });
    expect(status).toBe(200);
    const refs = Object.fromEntries(
      body.picks.map((p) => [p.speaker, p.voices.map((v) => v.voice)]),
    );
    expect(refs.Mara.length).toBeGreaterThan(0);
    expect(refs.Tom.length).toBeGreaterThan(0);
    for (const r of refs.Mara) expect(["studio/bea", "studio/dee"]).toContain(r);
    for (const r of refs.Tom) expect(["studio/ash", "studio/cy"]).toContain(r);
    expect(endpointRequests(api.db, "scripting", "sim", 0)).toEqual([
      expect.objectContaining({ bookId: id, label: "Voice suggestions" }),
    ]);
  });

  test.each([
    ["an unknown book", "nobody", { profile: "sim", speakers: ["Mara"] }, 404],
    ["an unknown profile", null, { profile: "nobody", speakers: ["Mara"] }, 404],
    ["a speaker not in the cast", null, { profile: "sim", speakers: ["Mara", "Zoe"] }, 400],
    [
      "more than 30 names",
      null,
      { profile: "sim", speakers: Array.from({ length: 31 }, (_, i) => `S${i}`) },
      400,
    ],
    ["no names", null, { profile: "sim", speakers: [] }, 400],
  ])("refuses %s", async (_, book, body, status) => {
    const { api, id } = await setup();
    expect((await ask(api, book ?? id, body)).status).toBe(status);
    expect(endpointRequests(api.db, "scripting", "sim", 0)).toHaveLength(0);
  });

  test("keep a speaker's own candidates only, once each, three at most, each why cut to 12 words", () => {
    const mara = { name: "Mara" } as Character;
    const tom = { name: "Tom" } as Character;
    const allowed = new Map([
      ["Mara", new Set(["e/a", "e/b", "e/c", "e/d"])],
      ["Tom", new Set(["e/x"])],
    ]);
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const said = {
      picks: [
        {
          speaker: "Mara",
          voices: [
            { voice: "e/x", why: "Tom's" },
            { voice: "e/a", why: long },
            { voice: "e/a", why: "again" },
            { voice: "e/b", why: "b" },
            { voice: "e/c", why: "c" },
            { voice: "e/d", why: "d" },
          ],
        },
      ],
    };
    expect(checkedPicks(said, [mara, tom], allowed)).toEqual({
      picks: [
        {
          speaker: "Mara",
          voices: [
            { voice: "e/a", why: long.split(" ").slice(0, 12).join(" ") },
            { voice: "e/b", why: "b" },
            { voice: "e/c", why: "c" },
          ],
        },
        { speaker: "Tom", voices: [] },
      ],
    });
  });
});
