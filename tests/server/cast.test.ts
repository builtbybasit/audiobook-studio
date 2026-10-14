// A book's cast over HTTP: a speaker renamed moves every line that names them, a merge folds one
// speaker into another, and an undo puts exactly the lines that moved back.
import { describe, expect, test } from "bun:test";

import type {
  Cast,
  Character,
  ImportedBook,
  LexEntry,
  MovedLines,
  MovedSpeakers,
  Segment,
} from "@/types";
import { readScript, scriptRevision } from "~/db/script";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

interface Failure {
  error: { code: string; message: string; detail?: string };
}

/** Prose that names exactly two speakers, so the cast it produces is known. */
const dialogue = () => [
  "The ledger lay open on the table. “We are short again,” said Mara.",
  "“Then we count it twice,” said Tobin.",
  "Rain ran down the shutters while they counted. Nobody else spoke.",
];

/** A shelved book whose first two chapters the fake model has scripted. */
async function scripted(api = testApi()) {
  const { body } = await api.import<ImportedBook>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: dialogue() })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 2] }));
  await api.runner.idle();
  return { api, id };
}

/** A shelved book nothing has scripted, for what does not need a cast. */
async function shelved(api = testApi()) {
  const { body } = await api.import<ImportedBook>(
    await epubFile({ chapters: [{ title: "One", paragraphs: story(2) }] }),
  );
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  return { api, id: body.book.id };
}

const castOf = async (api: TestApi, id: string) =>
  (await api.request<Cast>(`/api/books/${id}/cast`)).body;
const names = (cs: Character[]) => cs.map((c) => c.name);
const speakersOf = (segs: Segment[]) => [...new Set(segs.map((s) => s.speaker))];
const put = (body: unknown): RequestInit => ({ ...jsonBody(body), method: "PUT" });
const merge = (api: TestApi, id: string, merges: { from: string; into: string }[]) =>
  api.request<MovedSpeakers>(`/api/books/${id}/characters/merge`, jsonBody({ merges }));
const remove = (api: TestApi, id: string, ...names: string[]) =>
  api.request<MovedSpeakers>(`/api/books/${id}/characters/remove`, jsonBody({ names }));
const restore = (
  api: TestApi,
  id: string,
  speakers: { character: Character; lines: unknown[] }[],
) => api.request<MovedSpeakers>(`/api/books/${id}/characters/attribute`, jsonBody({ speakers }));

describe("the cast a scripting job leaves behind", () => {
  test("every speaker the script names is in the cast, the Narrator as main cast and the rest new", async () => {
    const { api, id } = await scripted();
    const { characters, lexicon } = await castOf(api, id);
    expect(names(characters)).toEqual(["Narrator", "Mara", "Tobin"]);
    expect(characters[0]).toMatchObject({ major: true, gender: "n" });
    expect(characters[0].isNew).toBeUndefined();
    expect(characters[1]).toMatchObject({ major: false, isNew: true, voice: null });
    // two chapters of the same speakers make one cast, not two
    expect(lexicon).toEqual([]);
  });

  test("a book nothing has scripted has no cast, and a book that does not exist is not found", async () => {
    const { api, id } = await shelved();
    expect(await castOf(api, id)).toEqual({ characters: [], lexicon: [] });
    expect((await api.request<Failure>("/api/books/nope/cast")).status).toBe(404);
  });
});

describe("writing a speaker", () => {
  test("replaces what is said about them and keeps their place in the cast", async () => {
    const { api, id } = await scripted();
    const mara = (await castOf(api, id)).characters[1];
    const { status, body } = await api.request<{ characters: Character[] }>(
      `/api/books/${id}/characters/Mara`,
      put({ ...mara, gender: "f", description: "Keeps the ledger.", isNew: false, keep: true }),
    );
    expect(status).toBe(200);
    expect(names(body.characters)).toEqual(["Narrator", "Mara", "Tobin"]);
    expect(body.characters[1]).toMatchObject({ gender: "f", description: "Keeps the ledger." });
    expect(body.characters[1].isNew).toBeUndefined();
    expect(body.characters[1].keep).toBe(true);
  });

  test("adds a speaker typed in by hand on the end of the cast", async () => {
    const { api, id } = await scripted();
    const { body } = await api.request<{ characters: Character[] }>(
      `/api/books/${id}/characters/${encodeURIComponent("The Clerk")}`,
      put({
        name: "The Clerk",
        aliases: [],
        gender: "?",
        description: "",
        voice: null,
        style: "",
        color: "#fbbf24",
        major: true,
      }),
    );
    expect(names(body.characters)).toEqual(["Narrator", "Mara", "Tobin", "The Clerk"]);
  });

  test("refuses a body that names a different speaker than the path, and a gender it has no word for", async () => {
    const { api, id } = await scripted();
    const mara = (await castOf(api, id)).characters[1];
    const wrong = await api.request<Failure>(`/api/books/${id}/characters/Tobin`, put(mara));
    expect(wrong.status).toBe(400);
    const bad = await api.request<Failure>(
      `/api/books/${id}/characters/Mara`,
      put({ ...mara, gender: "female" }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.detail).toContain("gender");
  });
});

describe("renaming and merging", () => {
  test("a rename moves every line in every chapter, and moves each chapter's revision on", async () => {
    const { api, id } = await scripted();
    const before = [scriptRevision(api.db, id, 1), scriptRevision(api.db, id, 2)];
    const { status, body } = await api.request<MovedLines>(
      `/api/books/${id}/characters/Mara/rename`,
      jsonBody({ to: "Mara Voss" }),
    );
    expect(status).toBe(200);
    expect(names(body.characters)).toEqual(["Narrator", "Mara Voss", "Tobin"]);
    expect(body.moved.map((m) => [m.chapterId, m.revision])).toEqual([
      [1, before[0]! + 1],
      [2, before[1]! + 1],
    ]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator", "Mara Voss", "Tobin"]);
    expect(speakersOf(readScript(api.db, id, 2))).toContain("Mara Voss");
    // a job in flight against either chapter must not land on top of this
    expect(scriptRevision(api.db, id, 1)).toBe(before[0]! + 1);
    expect(scriptRevision(api.db, id, 2)).toBe(before[1]! + 1);
    // and a chapter with none of their lines was not touched
    expect(scriptRevision(api.db, id, 3)).toBe(0);
  });

  test("a rename onto a name the cast has is refused and points at merging", async () => {
    const { api, id } = await scripted();
    const { status, body } = await api.request<Failure>(
      `/api/books/${id}/characters/Mara/rename`,
      jsonBody({ to: "Tobin" }),
    );
    expect(status).toBe(409);
    expect(body.error.detail).toContain("Merge");
  });

  test("a merge folds the name and its aliases into the speaker that stays", async () => {
    const { api, id } = await scripted();
    const { body } = await merge(api, id, [{ from: "Tobin", into: "Mara" }]);
    expect(names(body.characters)).toEqual(["Narrator", "Mara"]);
    expect(body.characters[1].aliases).toEqual(["Tobin"]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator", "Mara"]);
    expect(body.speakers.map((s) => [s.name, s.moved.length])).toEqual([["Tobin", 2]]);
  });

  test("removing speakers hands their lines to the Narrator, who cannot be removed", async () => {
    const { api, id } = await scripted();
    const { body } = await remove(api, id, "Tobin", "Mara");
    expect(names(body.characters)).toEqual(["Narrator"]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator"]);
    expect(body.speakers.map((s) => s.name)).toEqual(["Tobin", "Mara"]);
    expect((await remove(api, id, "Narrator")).status).toBe(409);
  });

  test.each([
    ["a removal", (api: TestApi, id: string) => remove(api, id, "Tobin", "Nobody")],
    [
      "a merge",
      (api: TestApi, id: string) =>
        merge(api, id, [
          { from: "Tobin", into: "Mara" },
          { from: "Mara", into: "Nobody" },
        ]),
    ],
  ])("%s that names someone the cast lacks changes no one", async (_, send) => {
    const { api, id } = await scripted();
    expect((await send(api, id)).status).toBe(404);
    expect(names((await castOf(api, id)).characters)).toEqual(["Narrator", "Mara", "Tobin"]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator", "Mara", "Tobin"]);
  });

  test("the Narrator is neither renamed nor merged away, though anyone can be merged into them", async () => {
    const { api, id } = await scripted();
    const renamed = await api.request<Failure>(
      `/api/books/${id}/characters/Narrator/rename`,
      jsonBody({ to: "Storyteller" }),
    );
    expect(renamed.status).toBe(409);
    expect(renamed.body.error.message).toContain("Narrator");
    const merged = await merge(api, id, [{ from: "Narrator", into: "Mara" }]);
    expect(merged.status).toBe(409);
    expect((merged.body as unknown as Failure).error.detail).toContain("into the Narrator");
    expect(names((await castOf(api, id)).characters)).toEqual(["Narrator", "Mara", "Tobin"]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator", "Mara", "Tobin"]);
    const into = await merge(api, id, [{ from: "Tobin", into: "Narrator" }]);
    expect(into.status).toBe(200);
    expect(names(into.body.characters)).toEqual(["Narrator", "Mara"]);
  });

  test("an undo puts exactly the lines that moved back, and the speaker with them", async () => {
    const { api, id } = await scripted();
    const tobin = (await castOf(api, id)).characters[2];
    const { body } = await merge(api, id, [{ from: "Tobin", into: "Mara" }]);
    const merged = body.speakers[0].moved;
    // the lines Mara always had stay hers, because the undo names only the lines that moved
    const { body: restored } = await restore(api, id, [
      { character: tobin, lines: merged.map(({ chapterId, ids }) => ({ chapterId, ids })) },
    ]);
    expect(names(restored.characters)).toEqual(["Narrator", "Mara", "Tobin"]);
    const back = restored.speakers[0].moved;
    expect(back.map((m) => m.ids)).toEqual(merged.map((m) => m.ids));
    expect(back.map((m) => m.revision)).toEqual(merged.map((m) => m.revision + 1));
    const lines = readScript(api.db, id, 1);
    expect(lines.filter((s) => s.speaker === "Tobin").map((s) => s.id)).toEqual(
      merged.find((m) => m.chapterId === 1)!.ids,
    );
  });

  test("a speaker the cast does not have is not found", async () => {
    const { api, id } = await scripted();
    const { status } = await api.request<Failure>(
      `/api/books/${id}/characters/Nobody/rename`,
      jsonBody({ to: "Somebody" }),
    );
    expect(status).toBe(404);
  });
});

describe("personas", () => {
  /** Write `name` as a new speaker, a persona of `of`; the answer says whether it was taken. */
  const persona = (api: TestApi, id: string, name: string, of: string) =>
    api.request<{ characters: Character[] } & Failure>(
      `/api/books/${id}/characters/${encodeURIComponent(name)}`,
      put({
        name,
        aliases: [],
        gender: "?",
        description: "",
        voice: null,
        style: "",
        color: "#fbbf24",
        major: false,
        personaOf: of,
      }),
    );
  const personaOf = async (api: TestApi, id: string) =>
    Object.fromEntries(
      (await castOf(api, id)).characters.flatMap((c) =>
        c.personaOf ? [[c.name, c.personaOf]] : [],
      ),
    );

  test("a link is kept, and refused to themselves, the Narrator, a stranger or another persona", async () => {
    const { api, id } = await scripted();
    expect((await persona(api, id, "The Mask", "Mara")).status).toBe(200);
    expect(await personaOf(api, id)).toEqual({ "The Mask": "Mara" });
    for (const [name, of, says] of [
      ["Ghost", "Ghost", "themselves"],
      ["Ghost", "Narrator", "Narrator"],
      ["Ghost", "Nobody", "not in this book"],
      ["Ghost", "The Mask", "persona of “Mara”"],
    ]) {
      const { status, body } = await persona(api, id, name, of);
      expect(status).toBe(400);
      expect(body.error.message).toContain(says);
    }
    // nor a persona of the Narrator, nor of someone who has personas of their own
    const mara = (await castOf(api, id)).characters.find((c) => c.name === "Mara")!;
    const narrator = (await castOf(api, id)).characters[0];
    for (const c of [
      { ...mara, personaOf: "Tobin" },
      { ...narrator, personaOf: "Tobin" },
    ]) {
      const { status } = await api.request<Failure>(
        `/api/books/${id}/characters/${c.name}`,
        put(c),
      );
      expect(status).toBe(400);
    }
    // and a persona is not refused an edit for the link they already have
    const mask = (await castOf(api, id)).characters.find((c) => c.name === "The Mask")!;
    const edit = await api.request(
      `/api/books/${id}/characters/${encodeURIComponent("The Mask")}`,
      put({ ...mask, style: "cold" }),
    );
    expect(edit.status).toBe(200);
  });

  test("follow their character through a rename, and are unlinked when the character goes", async () => {
    const { api, id } = await scripted();
    await persona(api, id, "The Mask", "Mara");
    await api.request(`/api/books/${id}/characters/Mara/rename`, jsonBody({ to: "Mara Voss" }));
    expect(await personaOf(api, id)).toEqual({ "The Mask": "Mara Voss" });
    await remove(api, id, "Mara Voss");
    expect(await personaOf(api, id)).toEqual({});
  });

  test("follow their character into a merge, unless the speaker that stays is a persona", async () => {
    const { api, id } = await scripted();
    await persona(api, id, "The Mask", "Tobin");
    await merge(api, id, [{ from: "Tobin", into: "Mara" }]);
    expect(await personaOf(api, id)).toEqual({ "The Mask": "Mara" });

    // Mara folded into a persona of hers: the stay is a speaker in their own right, and her other
    // personas are now theirs
    await persona(api, id, "Ghost", "Mara");
    await merge(api, id, [{ from: "Mara", into: "The Mask" }]);
    expect(await personaOf(api, id)).toEqual({ Ghost: "The Mask" });

    // folded into a persona: their personas are unlinked rather than chained
    const again = await scripted();
    await persona(again.api, again.id, "The Mask", "Mara");
    await persona(again.api, again.id, "Ghost", "Tobin");
    await merge(again.api, again.id, [{ from: "Tobin", into: "The Mask" }]);
    expect(await personaOf(again.api, again.id)).toEqual({ "The Mask": "Mara" });
  });

  test("an undo puts a persona back linked, unless the character is gone", async () => {
    const { api, id } = await scripted();
    await persona(api, id, "The Mask", "Mara");
    const { characters } = await castOf(api, id);
    const [mara, mask] = ["Mara", "The Mask"].map((n) => characters.find((c) => c.name === n)!);
    await remove(api, id, "The Mask");
    expect((await restore(api, id, [{ character: mask, lines: [] }])).status).toBe(200);
    expect(await personaOf(api, id)).toEqual({ "The Mask": "Mara" });

    await remove(api, id, "The Mask", "Mara");
    expect((await restore(api, id, [{ character: mask, lines: [] }])).status).toBe(200);
    expect(await personaOf(api, id)).toEqual({});
    // put back together, the persona comes back linked whichever is named first
    await remove(api, id, "The Mask");
    await restore(api, id, [
      { character: mask, lines: [] },
      { character: mara, lines: [] },
    ]);
    expect(await personaOf(api, id)).toEqual({ "The Mask": "Mara" });
  });
});

describe("the pronunciation dictionary", () => {
  test("is written whole and read back in the order it was written", async () => {
    const { api, id } = await shelved();
    const entries: LexEntry[] = [
      { id: 2, term: "Voss", say: "Voss", ipa: "vɒs", enabled: true },
      { id: 1, term: "ledger", say: "ledj-er", enabled: false, matchCase: true },
    ];
    const { body } = await api.request<{ entries: LexEntry[] }>(
      `/api/books/${id}/lexicon`,
      put({ entries }),
    );
    expect(body.entries).toEqual(entries);
    expect((await castOf(api, id)).lexicon).toEqual(entries);
    // replaced whole: what is sent is what there is
    await api.request(`/api/books/${id}/lexicon`, put({ entries: [] }));
    expect((await castOf(api, id)).lexicon).toEqual([]);
  });

  test("refuses two entries with one id", async () => {
    const { api, id } = await shelved();
    const { status } = await api.request<Failure>(
      `/api/books/${id}/lexicon`,
      put({
        entries: [
          { id: 1, term: "a", say: "b", enabled: true },
          { id: 1, term: "c", say: "d", enabled: true },
        ],
      }),
    );
    expect(status).toBe(400);
  });
});

describe("removing a book", () => {
  test("takes its cast and dictionary with it", async () => {
    const { api, id } = await scripted();
    await api.request(
      `/api/books/${id}/lexicon`,
      put({
        entries: [{ id: 1, term: "a", say: "b", enabled: true }],
      }),
    );
    // counted in the tables, because the book's own routes are a 404 once it is gone either way
    const rows = () =>
      ["characters", "lexicon_entries"].map(
        (table) => api.db.all<{ n: number }>(`select count(*) as n from ${table}`)[0].n,
      );
    expect(rows().every((n) => n > 0)).toBe(true);
    await api.request(`/api/books/${id}`, { method: "DELETE" });
    expect(rows()).toEqual([0, 0]);
  });
});
