// A book's cast over HTTP: a speaker renamed moves every line that names them, a merge folds one
// speaker into another, and an undo puts exactly the lines that moved back.
//
// Every test drives the real routes over a private database, with a script the fake model wrote
// from prose that names two speakers.
import { describe, expect, test } from "bun:test";

import type { Book, Chapter, Character, LexEntry, Segment } from "@/types";
import { readScript, scriptRevision } from "~/db/script";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
}
interface Cast {
  characters: Character[];
  lexicon: LexEntry[];
}
interface Moved {
  characters: Character[];
  moved: { chapterId: number; ids: number[]; revision: number }[];
}
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
  const { body } = await api.import<ImportResult>(
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

const castOf = async (api: TestApi, id: string) =>
  (await api.request<Cast>(`/api/books/${id}/cast`)).body;
const names = (cs: Character[]) => cs.map((c) => c.name);
const speakersOf = (segs: Segment[]) => [...new Set(segs.map((s) => s.speaker))];
const put = (body: unknown): RequestInit => ({ ...jsonBody(body), method: "PUT" });

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
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "One", paragraphs: story() }] }),
    );
    expect(await castOf(api, body.book.id)).toEqual({ characters: [], lexicon: [] });
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
    const { status, body } = await api.request<Moved>(
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
    const { body } = await api.request<Moved>(
      `/api/books/${id}/characters/Tobin/merge`,
      jsonBody({ into: "Mara" }),
    );
    expect(names(body.characters)).toEqual(["Narrator", "Mara"]);
    expect(body.characters[1].aliases).toEqual(["Tobin"]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator", "Mara"]);
    expect(body.moved).toHaveLength(2);
  });

  test("removing a speaker hands their lines to the Narrator, who cannot be removed", async () => {
    const { api, id } = await scripted();
    const { body } = await api.request<Moved>(`/api/books/${id}/characters/Tobin`, {
      method: "DELETE",
    });
    expect(names(body.characters)).toEqual(["Narrator", "Mara"]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator", "Mara"]);
    const narrator = await api.request<Failure>(`/api/books/${id}/characters/Narrator`, {
      method: "DELETE",
    });
    expect(narrator.status).toBe(409);
  });

  test("the Narrator is neither renamed nor merged away, though anyone can be merged into them", async () => {
    const { api, id } = await scripted();
    const renamed = await api.request<Failure>(
      `/api/books/${id}/characters/Narrator/rename`,
      jsonBody({ to: "Storyteller" }),
    );
    expect(renamed.status).toBe(409);
    expect(renamed.body.error.message).toContain("Narrator");
    const merged = await api.request<Failure>(
      `/api/books/${id}/characters/Narrator/merge`,
      jsonBody({ into: "Mara" }),
    );
    expect(merged.status).toBe(409);
    expect(merged.body.error.detail).toContain("into the Narrator");
    expect(names((await castOf(api, id)).characters)).toEqual(["Narrator", "Mara", "Tobin"]);
    expect(speakersOf(readScript(api.db, id, 1))).toEqual(["Narrator", "Mara", "Tobin"]);
    const into = await api.request<Moved>(
      `/api/books/${id}/characters/Tobin/merge`,
      jsonBody({ into: "Narrator" }),
    );
    expect(into.status).toBe(200);
    expect(names(into.body.characters)).toEqual(["Narrator", "Mara"]);
  });

  test("an undo puts exactly the lines that moved back, and the speaker with them", async () => {
    const { api, id } = await scripted();
    const tobin = (await castOf(api, id)).characters[2];
    const { body: merged } = await api.request<Moved>(
      `/api/books/${id}/characters/Tobin/merge`,
      jsonBody({ into: "Mara" }),
    );
    // the lines Mara always had stay hers, because the undo names only the lines that moved
    const { body: restored } = await api.request<Moved>(
      `/api/books/${id}/characters/attribute`,
      jsonBody({
        character: tobin,
        lines: merged.moved.map(({ chapterId, ids }) => ({ chapterId, ids })),
      }),
    );
    expect(names(restored.characters)).toEqual(["Narrator", "Mara", "Tobin"]);
    expect(restored.moved.map((m) => m.ids)).toEqual(merged.moved.map((m) => m.ids));
    expect(restored.moved.map((m) => m.revision)).toEqual(merged.moved.map((m) => m.revision + 1));
    const lines = readScript(api.db, id, 1);
    expect(lines.filter((s) => s.speaker === "Tobin").map((s) => s.id)).toEqual(
      merged.moved.find((m) => m.chapterId === 1)!.ids,
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

describe("the pronunciation dictionary", () => {
  test("is written whole and read back in the order it was written", async () => {
    const { api, id } = await scripted();
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
    const { api, id } = await scripted();
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
