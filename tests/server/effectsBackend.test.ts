// The library's voice effects over HTTP: listed, made, changed and removed, the thought effect
// beside them, and a book's and a speaker's choice of one, refused when unknown and reset when the
// effect goes. The migrations seed the Inner voice as the library's thought effect.
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import type { Book, Cast, Character, Effect, EffectUses, ImportedBook, Step } from "@/types";
import { SIMULATED_BASE_URL } from "@/lib/providers";
import { effectContext } from "~/db/effects";
import { characters, segments } from "~/db/schema";
import { readScript, scriptRevision } from "~/db/script";
import { epubFile, line, story } from "../support/epub";
import {
  jsonBody,
  narratedBook,
  saveEndpoints,
  speechEndpoint,
  testApi,
  type TestApi,
} from "../support/server";

const put = (body: unknown): RequestInit => ({ ...jsonBody(body), method: "PUT" });
const patch = (body: unknown): RequestInit => ({ ...jsonBody(body), method: "PATCH" });

const echo: Step[] = [
  { plugin: "Delay", params: { delay_seconds: 0.25, mix: 0.3 }, on: true },
  {
    mix: [
      { name: "dry", steps: [], on: true },
      {
        name: "wet",
        steps: [{ plugin: "Reverb", params: { room_size: 0.8 }, on: true }],
        on: true,
      },
    ],
    on: true,
  },
];

const list = async (api: TestApi) =>
  (await api.request<{ effects: Effect[] }>("/api/effects")).body.effects;
const create = (api: TestApi, name: string, chain: unknown = echo) =>
  api.request<{ effect: Effect }>("/api/effects", jsonBody({ name, chain }));
const thoughts = async (api: TestApi) =>
  (await api.request<{ effect: string }>("/api/settings/thoughts")).body.effect;

/** A shelved book; its id. */
async function shelved(api: TestApi, title?: string): Promise<string> {
  const { body } = await api.import<ImportedBook>(
    await epubFile({ title, chapters: [{ title: "One", paragraphs: story(2) }] }),
  );
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  return body.book.id;
}

const mara: Character = {
  name: "Mara",
  aliases: [],
  gender: "f",
  description: "",
  voice: null,
  style: "",
  color: "#f00",
  major: true,
};
const putMara = (api: TestApi, id: string, over: Record<string, unknown>) =>
  api.request<{ characters: Character[] }>(
    `/api/books/${id}/characters/Mara`,
    put({ ...mara, ...over }),
  );
const maraIn = async (api: TestApi, id: string) =>
  (await api.request<Cast>(`/api/books/${id}/cast`)).body.characters.find((c) => c.name === "Mara");

describe("the effects", () => {
  test("a library starts with the Inner voice, as its thought effect", async () => {
    const api = testApi();
    const effects = await list(api);
    expect(effects.map((e) => [e.id, e.name])).toEqual([["inner-voice", "Inner voice"]]);
    expect(effects[0].chain.map((s) => ("plugin" in s ? s.plugin : "mix"))).toEqual(["Reverb"]);
    expect(await thoughts(api)).toBe("inner-voice");
  });

  test("one made is listed after, by the slug of its name, made free", async () => {
    const api = testApi();
    const made = await create(api, "  Tin Can! ");
    expect(made.status).toBe(201);
    expect(made.body.effect).toEqual({ id: "tin-can", name: "Tin Can!", chain: echo });
    expect((await create(api, "Tin can")).body.effect.id).toBe("tin-can-2");
    // "none" is what no effect is written as, so it is never an effect's id
    expect((await create(api, "None")).body.effect.id).toBe("none-2");
    expect((await list(api)).map((e) => e.id)).toEqual([
      "inner-voice",
      "tin-can",
      "tin-can-2",
      "none-2",
    ]);
  });

  test("one changed keeps its id; one that is not there is a 404", async () => {
    const api = testApi();
    const changed = await api.request<{ effect: Effect }>(
      "/api/effects/inner-voice",
      put({ name: "Whisper", chain: [] }),
    );
    expect(changed.body.effect).toEqual({ id: "inner-voice", name: "Whisper", chain: [] });
    expect((await list(api))[0].name).toBe("Whisper");
    expect((await api.request("/api/effects/gone", put({ name: "X", chain: [] }))).status).toBe(
      404,
    );
    expect((await api.request("/api/effects/gone", { method: "DELETE" })).status).toBe(404);
  });

  test("a chain is refused unless it is plugins and mixes of names, keywords and numbers", async () => {
    const api = testApi();
    const step = (over: Record<string, unknown>) => [
      { plugin: "Gain", params: { gain_db: 1 }, on: true, ...over },
    ];
    const layer = (steps: unknown[]) => ({ mix: [{ name: "a", steps, on: true }], on: true });
    let deep: unknown[] = step({});
    for (let i = 0; i < 5; i++) deep = [layer(deep)];
    const refused = [
      step({ plugin: "__import__('os')" }),
      step({ plugin: "" }),
      step({ params: { "gain-db": 1 } }),
      step({ params: { gain_db: "1" } }),
      step({ on: "yes" }),
      step({ code: "print()" }),
      [{ mix: [], on: true }],
      [{ mix: [{ name: "a", steps: step({ plugin: "a.b" }), on: true }], on: true }],
      deep,
      "Gain",
    ];
    for (const chain of refused) expect((await create(api, "Bad", chain)).status).toBe(400);
    expect((await create(api, "", [])).status).toBe(400);
    expect(await list(api)).toHaveLength(1);
  });
});

describe("an effect's use-when and the lines that have it", () => {
  test("useWhen goes in, is read back, and an update without it clears it", async () => {
    const api = testApi();
    const useWhen = "words sent mind to mind, not spoken aloud";
    const made = await api.request<{ effect: Effect }>(
      "/api/effects",
      jsonBody({ name: "Telepathy", chain: echo, useWhen: `  ${useWhen} ` }),
    );
    expect(made.body.effect).toEqual({ id: "telepathy", name: "Telepathy", chain: echo, useWhen });
    expect((await list(api))[1]).toEqual(made.body.effect);

    const kept = await api.request<{ effect: Effect }>(
      "/api/effects/telepathy",
      put({ name: "Telepathy", chain: [], useWhen: "a mind speaking" }),
    );
    expect(kept.body.effect.useWhen).toBe("a mind speaking");
    // the body is the whole effect: left out, or blank, it is not offered any more
    for (const body of [{}, { useWhen: " " }, { useWhen: null }]) {
      await api.request("/api/effects/telepathy", put({ name: "T", chain: [], useWhen: "x" }));
      const cleared = await api.request<{ effect: Effect }>(
        "/api/effects/telepathy",
        put({ name: "T", chain: [], ...body }),
      );
      expect(cleared.body.effect).not.toHaveProperty("useWhen");
      expect((await list(api))[1]).not.toHaveProperty("useWhen");
    }
  });

  test("an effect removed is taken off every line that has it, and the rest stay in order", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: [["One", line("One")]] });
    await create(api, "Phone");
    await create(api, "Radio");
    const [a, b] = readScript(api.db, id, 1);
    const give = (seg: number, effects: string[]) =>
      api.db
        .update(segments)
        .set({ effects })
        .where(and(eq(segments.bookId, id), eq(segments.id, seg)))
        .run();
    give(a.id, ["radio", "phone"]);
    give(b.id, ["phone"]);
    expect((await api.request<EffectUses>("/api/effects/phone/uses")).body.lines).toBe(2);
    const copy = readScript(api.db, id, 1);
    const read = scriptRevision(api.db, id, 1);

    const removed = await api.request<{ lines: unknown }>("/api/effects/phone", {
      method: "DELETE",
    });
    // the chapter moves on, so a copy read before cannot write the id back
    expect(removed.body.lines).toEqual([
      { bookId: id, chapterId: 1, ids: [a.id, b.id], revision: read! + 1 },
    ]);
    const stale = await api.request(
      `/api/books/${id}/chapters/1/script`,
      put({ segments: copy, ifRevision: read }),
    );
    expect(stale.status).toBe(409);
    // nor can that copy sent at the new revision: the server drops ids no effect has
    const resent = await api.request(
      `/api/books/${id}/chapters/1/script`,
      put({ segments: copy, ifRevision: read! + 1 }),
    );
    expect(resent.status).toBe(200);
    const [a2, b2] = readScript(api.db, id, 1);
    expect(a2.effects).toEqual(["radio"]);
    expect(b2).not.toHaveProperty("effects");
    // none left is null, not an empty list
    const row = api.db
      .select({ e: segments.effects })
      .from(segments)
      .where(and(eq(segments.bookId, id), eq(segments.id, b.id)))
      .get();
    expect(row).toEqual({ e: null });
    // a new effect given the old id is not heard on them
    await create(api, "Phone");
    expect(readScript(api.db, id, 1).flatMap((s) => s.effects ?? [])).toEqual(["radio"]);
    // nor is an id some line still names (an import, a restored version) handed out again
    give(b.id, ["echo"]);
    expect((await create(api, "Echo")).body.effect.id).toBe("echo-2");
  });
});

describe("the library's thought effect", () => {
  test("is an effect or none, and an effect there is not is refused", async () => {
    const api = testApi();
    await create(api, "Echo");
    expect((await api.request("/api/settings/thoughts", put({ effect: "echo" }))).status).toBe(200);
    expect(await thoughts(api)).toBe("echo");
    expect((await api.request("/api/settings/thoughts", put({ effect: "none" }))).status).toBe(200);
    expect(await thoughts(api)).toBe("none");
    expect((await api.request("/api/settings/thoughts", put({ effect: "gone" }))).status).toBe(400);
    expect(await thoughts(api)).toBe("none");
  });

  test("a row that is missing or names nothing reads as the Inner voice, or none without it", async () => {
    const api = testApi();
    api.db.$client.exec("DELETE FROM settings WHERE key = 'thoughts'");
    expect(await thoughts(api)).toBe("inner-voice");
    api.db.$client.exec(`INSERT INTO settings (key, value) VALUES ('thoughts', '{"x":1}')`);
    expect(await thoughts(api)).toBe("inner-voice");
    api.db.$client.exec("DELETE FROM effects");
    expect(await thoughts(api)).toBe("none");
  });
});

describe("a book's and a speaker's choices", () => {
  test("name an effect, none, or null to follow; an effect there is not is a 400", async () => {
    const api = testApi();
    const id = await shelved(api);
    await create(api, "Echo");

    const book = (thoughts: string | null) =>
      api.request<{ book: Book }>(`/api/books/${id}`, patch({ thoughts }));
    expect((await book("echo")).body.book.thoughts).toBe("echo");
    expect((await book("gone")).status).toBe(400);
    expect((await book(null)).body.book).not.toHaveProperty("thoughts");

    expect((await putMara(api, id, { effect: "echo", thoughts: "none" })).status).toBe(200);
    expect(await maraIn(api, id)).toMatchObject({ effect: "echo", thoughts: "none" });
    expect((await putMara(api, id, { effect: "gone" })).status).toBe(400);
    expect((await putMara(api, id, { thoughts: "gone" })).status).toBe(400);
    // null and absent both clear: the row keeps no choice
    await putMara(api, id, { effect: null, thoughts: null });
    const back = await maraIn(api, id);
    expect(back).not.toHaveProperty("effect");
    expect(back).not.toHaveProperty("thoughts");
  });

  test("an effect removed takes every choice of it with it", async () => {
    const api = testApi();
    const id = await shelved(api);
    await create(api, "Echo");
    await create(api, "Phone");
    await api.request(`/api/books/${id}`, patch({ thoughts: "echo" }));
    await putMara(api, id, { effect: "echo", thoughts: "echo" });
    await api.request("/api/settings/thoughts", put({ effect: "echo" }));

    expect(effectContext(api.db, id)).toMatchObject({
      library: "echo",
      book: "echo",
      cast: new Map([["Mara", { effect: "echo", thoughts: "echo" }]]),
    });

    const removed = await api.request("/api/effects/echo", { method: "DELETE" });
    expect(removed).toEqual({ status: 200, body: { removed: "echo", lines: [] } });
    expect((await list(api)).map((e) => e.id)).toEqual(["inner-voice", "phone"]);
    // the book and the speaker follow again, the speaker wears nothing, and the library has none
    // rather than an effect nobody picked
    const ctx = effectContext(api.db, id);
    expect(ctx).toMatchObject({ library: "none", book: null, cast: new Map() });
    expect([...ctx.effects.keys()]).toEqual(["inner-voice", "phone"]);
    expect((await api.request<{ book: Book }>(`/api/books/${id}`)).body.book).not.toHaveProperty(
      "thoughts",
    );
    expect(await maraIn(api, id)).not.toHaveProperty("effect");
  });

  test.each([
    ["is sent where the endpoint takes it", SIMULATED_BASE_URL, undefined],
    ["is stretched here where it can't", "http://localhost:8880/v1", { stretched: 1.25 }],
  ])("a speaker's speed %s", async (_, baseUrl, want) => {
    const api = testApi();
    await saveEndpoints(api, [speechEndpoint({ baseUrl })]);
    const id = await shelved(api);
    await putMara(api, id, { voice: "studio/ash" });
    api.db
      .update(characters)
      .set({ speed: 1.25 })
      .where(and(eq(characters.bookId, id), eq(characters.name, "Mara")))
      .run();
    expect(effectContext(api.db, id).cast.get("Mara")).toEqual(want);
  });

  test("removing an effect the library does not use leaves its choice alone", async () => {
    const api = testApi();
    await create(api, "Echo");
    await api.request("/api/effects/echo", { method: "DELETE" });
    expect(await thoughts(api)).toBe("inner-voice");
  });
});

describe("where an effect goes", () => {
  test("one made after another sits right below it, and stays there", async () => {
    const api = testApi();
    await create(api, "Echo");
    await create(api, "Phone");
    const made = await api.request<{ effect: Effect }>(
      "/api/effects",
      jsonBody({ name: "Radio", chain: echo, after: "inner-voice" }),
    );
    expect(made.status).toBe(201);
    expect(made.body.effect.id).toBe("radio");
    // a fresh list from the database, not the order the page was told
    expect((await list(api)).map((e) => e.id)).toEqual(["inner-voice", "radio", "echo", "phone"]);
    await api.request("/api/effects", jsonBody({ name: "Last", chain: echo, after: "phone" }));
    expect((await list(api)).map((e) => e.id)).toEqual([
      "inner-voice",
      "radio",
      "echo",
      "phone",
      "last",
    ]);
  });

  test("after an effect there is not is a 400, and nothing is made", async () => {
    const api = testApi();
    const made = await api.request(
      "/api/effects",
      jsonBody({ name: "Echo", chain: echo, after: "gone" }),
    );
    expect(made.status).toBe(400);
    expect((await list(api)).map((e) => e.id)).toEqual(["inner-voice"]);
  });
});

describe("an effect's uses", () => {
  const uses = (api: TestApi, id: string) => api.request<EffectUses>(`/api/effects/${id}/uses`);

  test("are every choice of it across the books, by book title and then name", async () => {
    const api = testApi();
    await create(api, "Echo");
    const zebra = await shelved(api, "Zebra Days");
    const apple = await shelved(api, "Apple Nights");
    await api.request(`/api/books/${zebra}`, patch({ thoughts: "echo" }));
    await putMara(api, zebra, { effect: "echo" });
    await putMara(api, apple, { thoughts: "echo" });
    await api.request(
      `/api/books/${apple}/characters/Abe`,
      put({ ...mara, name: "Abe", effect: "echo", thoughts: "echo" }),
    );
    await api.request("/api/settings/thoughts", put({ effect: "echo" }));

    expect(await uses(api, "echo")).toEqual({
      status: 200,
      body: {
        lines: 0,
        library: true,
        books: [{ id: zebra, title: "Zebra Days" }],
        speakers: [
          { bookId: apple, bookTitle: "Apple Nights", name: "Abe", effect: true, thoughts: true },
          { bookId: apple, bookTitle: "Apple Nights", name: "Mara", effect: false, thoughts: true },
          { bookId: zebra, bookTitle: "Zebra Days", name: "Mara", effect: true, thoughts: false },
        ],
      },
    });
    // the Inner voice is no longer anyone's
    expect((await uses(api, "inner-voice")).body).toEqual({
      lines: 0,
      library: false,
      books: [],
      speakers: [],
    });
  });

  test("of an effect there is not are a 404", async () => {
    expect((await uses(testApi(), "gone")).status).toBe(404);
  });
});
