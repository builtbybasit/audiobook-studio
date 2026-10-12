// The library's voice effects over HTTP: listed, made, changed and removed, the library's thought
// effect beside them, and the choices a book and a speaker make of one — refused when they name an
// effect there is not, and reset when the effect they name is removed.
//
// Every test drives the real routes over a private database the migrations laid down, so it starts
// with the Inner voice as the library's thought effect.
import { describe, expect, test } from "bun:test";

import type { Book, Cast, Character, Effect, ImportedBook, Step } from "@/types";
import { effectContext } from "~/db/effects";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

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
async function shelved(api: TestApi): Promise<string> {
  const { body } = await api.import<ImportedBook>(
    await epubFile({ chapters: [{ title: "One", paragraphs: story(2) }] }),
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
    expect(effects[0].chain.map((s) => ("plugin" in s ? s.plugin : "mix"))).toEqual([
      "HighpassFilter",
      "LowpassFilter",
      "PeakFilter",
      "Compressor",
      "Reverb",
      "Gain",
    ]);
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
    expect(removed).toEqual({ status: 200, body: { removed: "echo" } });
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

  test("removing an effect the library does not use leaves its choice alone", async () => {
    const api = testApi();
    await create(api, "Echo");
    await api.request("/api/effects/echo", { method: "DELETE" });
    expect(await thoughts(api)).toBe("inner-voice");
  });
});
