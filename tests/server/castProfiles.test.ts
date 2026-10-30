// Cast profiles are rebuilt from source evidence, keep the user's hand-set tags, and skip disguises; facts jobs re-read scripted chapters;
// the facts routes and the refresh run, whose jobs count their requests' tokens.
import { describe, expect, test } from "bun:test";

import type { CastFact, Character, FactKind, Job } from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SCRIPTING_MODEL } from "@/lib/providers";
import { newProfile } from "@/lib/scripting";
import { rewriteProfiles, staleProfiles } from "~/cast/profiles";
import { getCharacter } from "~/db/cast";
import { clearBookFacts, deleteFact, readFacts, replaceChapterFacts } from "~/db/facts";
import { chapterIds } from "~/db/library";
import { fakeScriptingProvider } from "~/providers/fake";
import type { AskInput, ScriptingProvider } from "~/providers/scripting";
import { newSpeaker } from "@/lib/cast";
import { readScript, replaceScript } from "~/db/script";
import { line } from "../support/epub";
import { sourceParagraphs, numberedParagraphs, paragraphsIn } from "@/lib/sourceParagraphs";
import { groundedFacts } from "~/cast/facts";
import { jsonBody, speechEndpoint, testApi, voicedBook, type TestApi } from "../support/server";

const sim = newProfile({
  id: "sim",
  name: "Simulated",
  baseUrl: SIMULATED_BASE_URL,
  model: SIMULATED_SCRIPTING_MODEL,
});

test("paragraph IDs survive chunks, partial paragraphs and repeated text", () => {
  const source = "Heading\n\nSame words.\n\nSame words.\n\nA long final paragraph.";
  const parts = sourceParagraphs(source);
  expect(parts.map((p) => [p.id, p.text])).toEqual([
    [1, "Heading"],
    [2, "Same words."],
    [3, "Same words."],
    [4, "A long final paragraph."],
  ]);
  const offset = parts[3].from + 7;
  expect(numberedParagraphs(source, offset)).toBe("[P4]\nfinal paragraph.");
  expect(paragraphsIn(source, offset).map((p) => p.id)).toEqual([4]);
  const fact = { kind: "role" as const, text: "A claim.", sourceIds: [4, 4] };
  expect(groundedFacts([fact], source, new Set([4]))).toEqual([
    { ...fact, sourceIds: [4], evidence: parts[3].text },
  ]);
  expect(groundedFacts([{ ...fact, sourceIds: [3] }], source, new Set([4]))).toEqual([]);
  expect(groundedFacts([{ ...fact, sourceIds: [999] }], source)).toEqual([]);
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
async function setup(
  api: TestApi = testApi(),
  chapters = ["One"],
  paragraphs = [line("One"), line("Two", "Tom")],
) {
  const id = await voicedBook(api, {
    endpoints: [speechEndpoint()],
    paragraphs,
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
  rewriteProfiles(
    api.db,
    provider,
    id,
    "sim",
    names,
    new AbortController().signal,
    undefined,
    undefined,
    api.gate,
  );

describe("rewriting profiles", () => {
  test("a fatal request settles its in-flight peers before the rewrite returns", async () => {
    const { api, id, ids, add } = await setup();
    for (const name of ["Mara", "Tom"]) add(ids[0], name, "role", "A physician.");
    await api.request("/api/endpoints", {
      ...jsonBody({
        endpoints: [],
        profiles: [{ ...sim, concurrency: 2, maxOutputTokens: 1 }],
        credentials: [],
      }),
      method: "PUT",
    });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rec = asking(async (input) => {
      if (input.user.startsWith("## Mara")) throw new Error("fatal provider failure");
      entered();
      await waiting;
      return input.simulated;
    });
    let settled = false;
    const outcome = rewrite(api, id, rec.provider, ["Mara", "Tom"]).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await started;
    expect(settled).toBe(false);
    release();
    expect(await outcome).toEqual(new Error("fatal provider failure"));
    expect(api.gate.live().sim.active).toBe(0);
  });

  test.each([1, 2, 8])(
    "independent requests use concurrency %i and the shared gate",
    async (concurrency) => {
      const { api, id, ids, add } = await setup();
      await api.request(`/api/books/${id}/characters/Lena`, {
        ...jsonBody(newSpeaker("Lena", 3)),
        method: "PUT",
      });
      const names = ["Mara", "Tom", "Lena"];
      for (const name of names) add(ids[0], name, "role", `${name} is a physician.`);
      const saved = await api.request("/api/endpoints", {
        ...jsonBody({
          endpoints: [],
          profiles: [{ ...sim, concurrency, maxOutputTokens: 1 }],
          credentials: [],
        }),
        method: "PUT",
      });
      expect(saved.status).toBe(200);
      const expected = Math.min(concurrency, names.length);
      let active = 0;
      let peak = 0;
      let hold = true;
      const releases: (() => void)[] = [];
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const rec = asking(async (input) => {
        active++;
        peak = Math.max(peak, active);
        if (hold) {
          const wait = new Promise<void>((resolve) => releases.push(resolve));
          if (active === expected) started();
          await wait;
        }
        active--;
        return input.simulated;
      });
      const running = rewrite(api, id, rec.provider, names);
      await ready;
      expect(rec.asked).toHaveLength(expected);
      expect(api.gate.live().sim.active).toBe(expected);
      hold = false;
      for (const release of releases) release();
      const result = await running;
      expect(new Set(result.rewritten)).toEqual(new Set(names));
      expect(result.failed).toEqual([]);
      expect(peak).toBe(expected);
      expect(api.gate.live().sim.active).toBe(0);
    },
  );

  test("rebuilds from all evidence so omitted facts can return; a removed fact is left out", async () => {
    const { api, id, ids, add } = await setup(testApi(), ["One", "Two"]);
    add(ids[0], "Mara", "role", "A lamplighter.");
    const { provider, asked } = asking();
    await rewrite(api, id, provider, ["Mara"]);
    add(ids[1], "Mara", "personality", "Wary of strangers.");
    await rewrite(api, id, provider, ["Mara"]);
    expect(asked[1].user).toContain("- personality: Wary of strangers.");
    expect(asked[1].user).toContain("- role: A lamplighter.");
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
    set(`age = 'elderly', voice_type = '{"texture":"husky"}' where name = 'Tom'`);
    const { provider, asked } = asking(() => ({
      profiles: ["Mara", "Tom"].map((speaker) => ({
        speaker: speaker.toLowerCase(),
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
    expect(asked[0].user).toContain("teen");
    expect(asked[0].user).not.toContain("elderly");
    expect(asked[0].user).not.toContain("husky");
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
    const { provider } = asking((input) => input.simulated);
    const { api, id, ids } = await setup(testApi({ scripting: provider }), ["One", "Two", "Three"]);
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

test("removing the last fact clears its generated claim", async () => {
  const { api, id, ids, add } = await setup();
  add(ids[0], "Mara", "role", "A physician.");
  const { provider } = asking();
  await rewrite(api, id, provider, ["Mara"]);
  deleteFact(api.db, id, readFacts(api.db, id, "Mara")[0].id);
  await rewrite(api, id, provider, ["Mara"]);
  expect(getCharacter(api.db, id, "Mara")?.profile?.who ?? "").toBe("");
});
test("an edit while a profile request is in flight survives", async () => {
  const { api, id, ids, add } = await setup();
  add(ids[0], "Mara", "role", "A physician.");
  const fake = fakeScriptingProvider();
  const provider: ScriptingProvider = {
    ...fake,
    async ask() {
      const mara = getCharacter(api.db, id, "Mara")!;
      const saved = await api.request(`/api/books/${id}/characters/Mara`, {
        ...jsonBody({ ...mara, age: "teen" }),
        method: "PUT",
      });
      expect(saved.status).toBe(200);
      return {
        profiles: [
          {
            speaker: "Mara",
            who: "A physician.",
            personality: "",
            voice: "",
            age: "elderly",
            voiceType: null,
          },
        ],
      };
    },
  };
  await rewrite(api, id, provider, ["Mara"]);
  expect(getCharacter(api.db, id, "Mara")?.age).toBe("teen");
});
test("deleting evidence during a rewrite keeps it marked for rebuild", async () => {
  const { api, id, ids, add } = await setup(testApi(), ["One", "Two"]);
  add(ids[0], "Mara", "role", "A physician.");
  add(ids[1], "Mara", "background", "Lives in the village.");
  const fake = fakeScriptingProvider();
  const provider: ScriptingProvider = {
    ...fake,
    async ask() {
      deleteFact(api.db, id, readFacts(api.db, id, "Mara")[0].id);
      return {
        profiles: [
          {
            speaker: "Mara",
            who: "A physician in the village.",
            personality: "",
            voice: "",
            age: "unknown",
            voiceType: null,
          },
        ],
      };
    },
  };
  await rewrite(api, id, provider, ["Mara"]);
  expect(staleProfiles(api.db, id)).toContain("Mara");
});

test("refresh reads original prose and includes a character mentioned only in narration", async () => {
  const quote = "Lena’s gift was called “Sight”… she could see the future.";
  const rec = asking((input) =>
    input.system.startsWith("Read the original prose")
      ? {
          speakers: [
            { speaker: "mara", facts: [] },
            { speaker: "tom", facts: [] },
            {
              speaker: "Lena",
              facts: [
                {
                  kind: "role",
                  text: "Has visions of the future.",
                  sourceIds: [4],
                },
              ],
            },
          ],
        }
      : input.simulated,
  );
  const { api, id, ids } = await setup(
    testApi({ scripting: rec.provider }),
    ["One", "Two"],
    [line("One"), line("Two", "Tom"), quote],
  );
  await api.request(`/api/books/${id}/characters/Lena`, {
    ...jsonBody(newSpeaker("Lena", 3)),
    method: "PUT",
  });
  api.db.transaction((tx) =>
    replaceScript(
      tx,
      id,
      ids[0],
      readScript(tx, id, ids[0]).map((s) => ({ ...s, speaker: "Tom", text: "EDITED SCRIPT ONLY" })),
    ),
  );
  await api.request(
    `/api/books/${id}/characters/refresh`,
    jsonBody({ profile: "sim", chapters: [ids[1]] }),
  );
  await api.runner.idle();
  const input = rec.asked[0];
  expect(input.user).toContain("Lena");
  expect(input.user).toContain(quote);
  expect(input.user).not.toContain("EDITED SCRIPT ONLY");
  expect(input.user.split("Original prose:")[0]).toContain(`Previous prose (context only):`);
  expect(input.user.split("Original prose:")[0]).toContain(quote);
  expect(readFacts(api.db, id, "Lena")).toEqual([
    expect.objectContaining({
      chapterId: ids[1],
      sourceIds: [4],
      evidence: quote,
      text: "Has visions of the future.",
    }),
  ]);
});

test.each([
  {
    speakers: [
      {
        speaker: "Mara",
        facts: [{ kind: "role", text: "A physician.", evidence: "An invented quotation." }],
      },
      { speaker: "Tom", facts: [] },
    ],
  },
  { speakers: [{ speaker: "Mara", facts: [] }] },
  { wrong: [] },
])("a bad extraction keeps the chapter's existing facts (%j)", async (answer) => {
  const rec = asking((input) =>
    input.system.startsWith("Read the original prose") ? answer : input.simulated,
  );
  const { api, id, ids, add } = await setup(testApi({ scripting: rec.provider }));
  add(ids[0], "Mara", "role", "A physician.");
  const before = readFacts(api.db, id, "Mara");
  await api.request(`/api/books/${id}/characters/refresh`, jsonBody({ profile: "sim" }));
  await api.runner.idle();
  expect(readFacts(api.db, id, "Mara")).toEqual(before);
  const { body } = await api.request<{ jobs: Job[] }>("/api/jobs");
  expect(body.jobs.find((j) => j.kind === "facts")?.status).toBe("failed");
  expect(rec.asked).toHaveLength(2);
});

test("an invalid extraction is corrected once before replacing existing facts", async () => {
  const quote = "Mara is a physician.";
  const rec = asking((input) =>
    !input.system.startsWith("Read the original prose")
      ? input.simulated
      : !input.user.includes("Your last reply failed validation")
        ? {
            speakers: [
              {
                speaker: "Mara",
                facts: [{ kind: "role", text: quote, sourceIds: [999] }],
              },
              { speaker: "Tom", facts: [] },
            ],
          }
        : {
            speakers: [
              { speaker: "Mara", facts: [{ kind: "role", text: quote, sourceIds: [4] }] },
              { speaker: "Tom", facts: [] },
            ],
          },
  );
  const { api, id, ids, add } = await setup(
    testApi({ scripting: rec.provider }),
    ["One"],
    [line("One"), line("Two", "Tom"), quote],
  );
  add(ids[0], "Mara", "role", "Old unsupported claim.");
  await api.request(`/api/books/${id}/characters/refresh`, jsonBody({ profile: "sim" }));
  await api.runner.idle();
  expect(readFacts(api.db, id, "Mara")).toEqual([
    expect.objectContaining({ text: quote, evidence: quote }),
  ]);
  const { body } = await api.request<{ jobs: Job[] }>("/api/jobs");
  expect(body.jobs.find((j) => j.kind === "facts")?.status).toBe("done");
  expect(rec.asked.filter((a) => a.system.startsWith("Read the original prose"))).toHaveLength(2);
  expect(rec.asked[1].user).toContain("999");
});

test.each([500, 2600])(
  "profile length %i is preserved whole or refused, never silently cut",
  async (length) => {
    const { api, id, ids, add } = await setup();
    add(ids[0], "Mara", "role", "A physician who cannot lie.");
    const who = "A".repeat(length) + " Cannot lie.";
    const { provider } = asking(() => ({
      profiles: [
        { speaker: "Mara", who, personality: "", voice: "", age: "unknown", voiceType: null },
      ],
    }));
    const out = await rewrite(api, id, provider, ["Mara"]);
    expect(out.failed).toEqual(length > 2400 ? ["Mara"] : []);
    expect(getCharacter(api.db, id, "Mara")?.profile?.who).toBe(length > 2400 ? undefined : who);
  },
);

test("an earlier chapter added later is summarized before later revelations", async () => {
  const { api, id, ids, add } = await setup(testApi(), ["One", "Two"]);
  add(ids[1], "Mara", "role", "Revealed as a physician.");
  const rec = asking((input) => input.simulated);
  await rewrite(api, id, rec.provider, ["Mara"]);
  add(ids[0], "Mara", "role", "Initially mistaken for a servant.");
  await rewrite(api, id, rec.provider, ["Mara"]);
  const prompt = rec.asked[1].user;
  expect(prompt).toContain("Profile so far: none");
  expect(prompt.indexOf("Initially mistaken")).toBeGreaterThan(-1);
  expect(prompt.indexOf("Initially mistaken")).toBeLessThan(prompt.indexOf("Revealed as"));
});
