// Cast profiles from facts: the rewrite folds in only what is new (or everything after a rebuild
// mark), keeps the user's hand-set tags and skips disguises; facts jobs re-read scripted chapters;
// the facts routes and the refresh run, whose jobs count their requests' tokens.
import { describe, expect, test } from "bun:test";

import type { CastFact, Character, FactKind, Job } from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SCRIPTING_MODEL } from "@/lib/providers";
import { newProfile } from "@/lib/scripting";
import { rewriteProfiles } from "~/cast/profiles";
import { getCharacter } from "~/db/cast";
import { clearBookFacts, deleteFact, readFacts, replaceChapterFacts } from "~/db/facts";
import { chapterIds } from "~/db/library";
import { fakeScriptingProvider } from "~/providers/fake";
import type { AskInput, ScriptingProvider } from "~/providers/scripting";
import { line } from "../support/epub";
import { jsonBody, speechEndpoint, testApi, voicedBook, type TestApi } from "../support/server";

const sim = newProfile({
  id: "sim",
  name: "Simulated",
  baseUrl: SIMULATED_BASE_URL,
  model: SIMULATED_SCRIPTING_MODEL,
});

/** The fake, with every `ask` kept; `answer` replaces what it says. */
function asking(answer?: (input: AskInput) => unknown) {
  const fake = fakeScriptingProvider();
  const asked: AskInput[] = [];
  const provider: ScriptingProvider = {
    ...fake,
    ask: (input) => {
      asked.push(input);
      return answer ? Promise.resolve(answer(input)) : fake.ask!(input);
    },
  };
  return { provider, asked };
}

/**
 * Mara and Tom speaking in each of `chapters`, the simulated profile saved, and no facts but the
 * test's: `add` sets a speaker's facts for one chapter.
 */
async function setup(api: TestApi = testApi(), chapters = ["One"]) {
  const id = await voicedBook(api, {
    endpoints: [speechEndpoint()],
    paragraphs: [line("One"), line("Two", "Tom")],
    voiceOf: "studio/ash",
    chapters,
  });
  await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [speechEndpoint()], profiles: [sim], credentials: [] }),
    method: "PUT",
  });
  api.db.transaction((tx) => clearBookFacts(tx, id));
  const add = (chapter: number, speaker: string, kind: FactKind, text: string) =>
    api.db.transaction((tx) =>
      replaceChapterFacts(tx, id, chapter, [{ speaker, kind, text }], [speaker]),
    );
  const set = (sql: string) => api.db.run(`update characters set ${sql}`);
  return { api, id, ids: chapterIds(api.db, id), add, set };
}

const rewrite = (api: TestApi, id: string, provider: ScriptingProvider, names: string[]) =>
  rewriteProfiles(api.db, provider, id, "sim", names, new AbortController().signal);

describe("rewriting profiles", () => {
  test("folds in only facts newer than the profile; a removed fact rebuilds from the rest", async () => {
    const { api, id, ids, add } = await setup(testApi(), ["One", "Two"]);
    add(ids[0], "Mara", "role", "A lamplighter.");
    const { provider, asked } = asking();
    await rewrite(api, id, provider, ["Mara"]);
    add(ids[1], "Mara", "personality", "Wary of strangers.");
    await rewrite(api, id, provider, ["Mara"]);
    expect(asked[1].user).toContain("- personality: Wary of strangers.");
    expect(asked[1].user).not.toContain("- role: A lamplighter.");
    expect(getCharacter(api.db, id, "Mara")?.profile).toMatchObject({
      who: "A lamplighter.",
      personality: "Wary of strangers.",
    });

    deleteFact(api.db, id, readFacts(api.db, id, "Mara")[0].id);
    await rewrite(api, id, provider, ["Mara"]);
    expect(asked[2].user).toContain("Profile so far: none");
    expect(getCharacter(api.db, id, "Mara")?.profile?.who).toBe("");
    // up to date: nothing is asked
    await rewrite(api, id, provider, ["Mara"]);
    expect(asked).toHaveLength(3);
  });

  test("corrects age only where the user did not set it, and skips disguises", async () => {
    const { api, id, ids, add, set } = await setup();
    for (const name of ["Mara", "Tom"]) add(ids[0], name, "role", `${name} is here.`);
    add(ids[0], "Narrator", "role", "Tells the story.");
    set(`age = 'teen', edited = '["age"]' where name = 'Mara'`);
    const { provider, asked } = asking(() => ({
      profiles: ["Mara", "Tom"].map((speaker) => ({
        speaker,
        who: "w",
        personality: "p",
        voice: "v",
        age: "elderly",
        voiceType: null,
      })),
    }));
    expect((await rewrite(api, id, provider, ["Mara", "Tom", "Narrator"])).rewritten).toEqual([
      "Mara",
      "Tom",
    ]);
    expect(getCharacter(api.db, id, "Mara")?.age).toBe("teen");
    expect(getCharacter(api.db, id, "Tom")?.age).toBe("elderly");

    set(`persona_of = 'Mara' where name = 'Tom'`);
    add(ids[0], "Tom", "role", "Mara in a mask.");
    expect((await rewrite(api, id, provider, ["Tom"])).rewritten).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0].user).not.toContain("## Narrator");
  });
});

describe("refreshing facts", () => {
  test("major only replaces the majors' facts and keeps the others', then profiles follow", async () => {
    const { api, id, ids, add } = await setup();
    add(ids[0], "Mara", "role", "Old fact.");
    add(ids[0], "Tom", "role", "Tom's fact.");
    const { body: cast } = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
    const mara = cast.characters.find((c) => c.name === "Mara")!;
    await api.request(`/api/books/${id}/characters/Mara`, {
      ...jsonBody({ ...mara, major: true }),
      method: "PUT",
    });
    const run = await api.request<{ queued: number }>(
      `/api/books/${id}/characters/refresh`,
      jsonBody({ profile: "sim", major: true }),
    );
    expect(run).toEqual({ status: 202, body: { queued: 1 } });
    await api.runner.idle();
    const texts = (name: string) => readFacts(api.db, id, name).map((f) => f.text);
    expect(texts("Mara")).not.toContain("Old fact.");
    expect(texts("Tom")).toEqual(["Tom's fact."]);
    expect(getCharacter(api.db, id, "Tom")?.profile?.who).toBe("Tom's fact.");
    // each job counts what its requests used
    const { body } = await api.request<{ jobs: Job[] }>("/api/jobs");
    const facts = body.jobs.find((j) => j.kind === "facts")?.factsRun;
    const profiles = body.jobs.find((j) => j.kind === "profiles")?.profilesRun;
    expect(facts).toMatchObject({ speakers: 1, usage: { requests: 1 } });
    expect(profiles).toMatchObject({ rewritten: profiles?.speakers, usage: { requests: 1 } });
    expect(facts?.usage?.inputTokens).toBeGreaterThan(0);
    expect(profiles?.usage?.outputTokens).toBeGreaterThan(0);
  });

  test("takes a range of reading numbers or a Retry's chapters, and refuses an unknown endpoint", async () => {
    const { api, id, ids } = await setup(testApi(), ["One", "Two", "Three"]);
    const refresh = (body: unknown) =>
      api.request<{ queued: number }>(`/api/books/${id}/characters/refresh`, jsonBody(body));
    expect((await refresh({ profile: "sim", from: 2, to: 3 })).body.queued).toBe(2);
    await api.runner.idle();
    expect((await refresh({ profile: "sim", chapters: [ids[0]] })).body.queued).toBe(1);
    expect((await refresh({ profile: "nobody" })).status).toBe(404);
    await api.runner.idle();
  });
});

describe("the facts routes", () => {
  test("list a speaker's facts in reading order; deleting one returns the rest", async () => {
    const { api, id, ids, add } = await setup(testApi(), ["One", "Two"]);
    add(ids[1], "Mara", "voice", "Hoarse.");
    add(ids[0], "Mara", "role", "A lamplighter.");
    const url = `/api/books/${id}/characters`;
    const listed = await api.request<{ facts: CastFact[] }>(`${url}/Mara/facts`);
    expect(listed.body.facts.map((f) => f.text)).toEqual(["A lamplighter.", "Hoarse."]);
    const left = await api.request<{ facts: CastFact[] }>(
      `${url}/facts/${listed.body.facts[0].id}`,
      { method: "DELETE" },
    );
    expect(left.body.facts.map((f) => f.text)).toEqual(["Hoarse."]);
    const again = await api.request(`${url}/facts/${listed.body.facts[0].id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
    expect((await api.request(`${url}/Zoe/facts`)).status).toBe(404);
  });
});
