// Import → review contents → add, over HTTP.
//
// The rules here are the ones `src/stores/library.ts` already applies in the demo: nothing is
// deleted by a skip, including a noted chapter counts as having looked at it, a book waits out of
// the library until its review is confirmed, and chapter numbering stays continuous across
// volumes whatever is added or removed.
import { describe, expect, test } from "bun:test";

import type { Book, Chapter } from "@/types";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi } from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
  volumeId?: number;
}
interface ChapterResult {
  changed: number;
  chapters: Chapter[];
}

const volume = (titles: string[]) =>
  epubFile({ chapters: titles.map((title) => ({ title, paragraphs: story() })) });

/** A book of three story chapters and one hiatus notice, already imported and waiting for review. */
async function imported(api = testApi()) {
  const file = await epubFile({
    title: "Moonlight Ledger",
    chapters: [
      { title: "The Ledger Opens", paragraphs: story() },
      {
        title: "A short break",
        paragraphs: [
          "Going on hiatus for a few weeks. Thank you for reading, and for your patience.",
        ],
      },
      { title: "Salt Tax", paragraphs: story() },
      { title: "Arrears", paragraphs: story() },
    ],
  });
  const { body } = await api.import<ImportResult>(file);
  return { api, ...body };
}

describe("the contents review", () => {
  test("the import suggests the notice and leaves the story alone", async () => {
    const { chapters } = await imported();
    expect(chapters.map((c) => c.note?.kind)).toEqual([undefined, "hiatus", undefined, undefined]);
    // nothing is skipped by the import itself — the review is where the decision is made
    expect(chapters.some((c) => c.excluded)).toBe(false);
  });

  test("skipping a chapter keeps it in the book", async () => {
    const { api, book } = await imported();
    const { body } = await api.request<ChapterResult>(
      `/api/books/${book.id}/chapters/skip`,
      jsonBody({ ids: [2] }),
    );
    expect(body.changed).toBe(1);
    expect(body.chapters).toHaveLength(4);
    expect(body.chapters[1].excluded).toBe(true);
    // its text is untouched: a skip is reversible, and this is what makes it so
    const text = await api.request<{ text: string }>(`/api/books/${book.id}/chapters/2/text`);
    expect(text.status).toBe(200);
    expect(text.body.text).toContain("hiatus");
  });

  test("skipping the same chapter twice changes nothing the second time", async () => {
    const { api, book } = await imported();
    const skip = () =>
      api.request<ChapterResult>(`/api/books/${book.id}/chapters/skip`, jsonBody({ ids: [2] }));
    expect((await skip()).body.changed).toBe(1);
    expect((await skip()).body.changed).toBe(0);
  });

  test("including a chapter that carries a note counts as having read it", async () => {
    const { api, book } = await imported();
    await api.request(`/api/books/${book.id}/chapters/skip`, jsonBody({ ids: [2] }));
    const { body } = await api.request<ChapterResult>(
      `/api/books/${book.id}/chapters/include`,
      jsonBody({ ids: [2] }),
    );
    expect(body.chapters[1].excluded).toBeUndefined();
    // the suggestion stops asking, but the note stays visible in the review
    expect(body.chapters[1].kept).toBe(true);
    expect(body.chapters[1].note?.kind).toBe("hiatus");
  });

  test("keeping a noted chapter settles it without a skip first", async () => {
    const { api, book } = await imported();
    const { body } = await api.request<ChapterResult>(
      `/api/books/${book.id}/chapters/keep`,
      jsonBody({ ids: [2] }),
    );
    expect(body.changed).toBe(1);
    expect(body.chapters[1].kept).toBe(true);
  });

  test("a chapter with no note has nothing to keep", async () => {
    const { api, book } = await imported();
    const { body } = await api.request<ChapterResult>(
      `/api/books/${book.id}/chapters/keep`,
      jsonBody({ ids: [1] }),
    );
    expect(body.changed).toBe(0);
    expect(body.chapters[0].kept).toBeUndefined();
  });

  test("decisions can be put back exactly, which is what an undo needs", async () => {
    const { api, book } = await imported();
    // skip the notice, undo: it must come back undecided, not "looked at"
    await api.request(`/api/books/${book.id}/chapters/skip`, jsonBody({ ids: [2] }));
    const undone = await api.request<ChapterResult>(
      `/api/books/${book.id}/chapters/decisions`,
      jsonBody({ decisions: [{ id: 2 }] }),
    );
    expect(undone.body.changed).toBe(1);
    expect(undone.body.chapters[1].excluded).toBeUndefined();
    expect(undone.body.chapters[1].kept).toBeUndefined();
    // keep it, undo: the same, through the same route
    await api.request(`/api/books/${book.id}/chapters/keep`, jsonBody({ ids: [2] }));
    const unkept = await api.request<ChapterResult>(
      `/api/books/${book.id}/chapters/decisions`,
      jsonBody({ decisions: [{ id: 2 }] }),
    );
    expect(unkept.body.chapters[1].kept).toBeUndefined();
    // and a decision can be stated outright, both halves at once
    const stated = await api.request<ChapterResult>(
      `/api/books/${book.id}/chapters/decisions`,
      jsonBody({
        decisions: [{ id: 2, excluded: true, kept: true }, { id: 1, kept: true }, { id: 99 }],
      }),
    );
    expect(stated.body.chapters[1]).toMatchObject({ excluded: true, kept: true });
    // `kept` means nothing on a chapter with no note, and an unknown chapter is left out, not refused
    expect(stated.body.chapters[0].kept).toBeUndefined();
    expect(stated.body.changed).toBe(1);
  });

  test("confirming the review puts the book on the shelf", async () => {
    const { api, book } = await imported();
    const { body } = await api.request<{ book: Book }>(`/api/books/${book.id}/confirm`, {
      method: "POST",
    });
    expect(body.book.importing).toBeUndefined();
    expect(body.book.volumes.every((v) => !v.importing)).toBe(true);
  });

  test("discarding an unconfirmed import takes the whole book with it", async () => {
    const { api, book } = await imported();
    const { body } = await api.request<{ discarded: string }>(`/api/books/${book.id}/discard`, {
      method: "POST",
    });
    expect(body.discarded).toBe("book");
    const list = await api.request<{ books: Book[] }>("/api/books");
    expect(list.body.books).toHaveLength(0);
  });

  test("decisions survive a fresh read of the book", async () => {
    const { api, book } = await imported();
    await api.request(`/api/books/${book.id}/chapters/skip`, jsonBody({ ids: [2] }));
    await api.request(`/api/books/${book.id}/confirm`, { method: "POST" });
    const { body } = await api.request<ImportResult>(`/api/books/${book.id}`);
    expect(body.book.importing).toBeUndefined();
    expect(body.chapters[1].excluded).toBe(true);
    expect(body.chapters[1].note?.kind).toBe("hiatus");
  });

  test("the shelf carries each book's chapter counts, so a card can say so before the book is opened", async () => {
    const { api, book } = await imported();
    await api.request(`/api/books/${book.id}/chapters/skip`, jsonBody({ ids: [2] }));
    await api.request(`/api/books/${book.id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${book.id}/chapters/script`, jsonBody({ ids: [1] }));
    await api.runner.idle();
    const { body } = await api.request<{ books: Book[] }>("/api/books");
    expect(body.books[0].chapters).toEqual({ total: 4, included: 3, scripted: 1, narrated: 0 });
    // and the same counts on the book itself, so the two never disagree
    const one = await api.request<ImportResult>(`/api/books/${book.id}`);
    expect(one.body.book.chapters).toEqual(body.books[0].chapters);
  });
});

describe("a novel split across several EPUBs", () => {
  test("a second volume numbers its chapters after the first", async () => {
    const api = testApi();
    const first = await api.import<ImportResult>(await volume(["One", "Two"]), {
      title: "Moonlight Ledger",
    });
    const id = first.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });

    const second = await api.import<ImportResult>(await volume(["Three", "Four"]), {
      bookId: id,
      name: "Vol. 2",
    });
    expect(second.status).toBe(201);
    // numbering is continuous across the boundary, which is what keeps chapter keys unique
    expect(second.body.chapters.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(second.body.chapters.map((c) => c.title)).toEqual(["One", "Two", "Three", "Four"]);
    const vols = second.body.book.volumes;
    expect(vols.map((v) => [v.from, v.to])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    // the new volume waits in the review the way a new book would
    expect(vols[1].importing).toBe(true);
    expect(second.body.book.importing).toBeUndefined();
  });

  test("discarding a new volume leaves the book it was added to", async () => {
    const api = testApi();
    const first = await api.import<ImportResult>(await volume(["One", "Two"]));
    const id = first.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.import<ImportResult>(await volume(["Three"]), { bookId: id });

    const { body } = await api.request<{ discarded: string }>(`/api/books/${id}/discard`, {
      method: "POST",
    });
    expect(body.discarded).toBe("volume");
    const after = await api.request<ImportResult>(`/api/books/${id}`);
    expect(after.body.book.volumes).toHaveLength(1);
    expect(after.body.chapters.map((c) => c.title)).toEqual(["One", "Two"]);
  });

  test("only one volume can be waiting in a book's review at a time", async () => {
    const api = testApi();
    const first = await api.import<ImportResult>(await volume(["One"]));
    const id = first.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.import<ImportResult>(await volume(["Two"]), { bookId: id });

    const third = await api.import<{ error: { message: string } }>(await volume(["Three"]), {
      bookId: id,
    });
    expect(third.status).toBe(409);
    expect(third.body.error.message).toContain("already has a volume waiting");
  });

  test("a volume with nowhere to go is refused before the file is read", async () => {
    const api = testApi();
    const first = await api.import<ImportResult>(await volume(["One"]));
    const id = first.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.import<ImportResult>(await volume(["Two"]), { bookId: id });

    // Neither of these files is an EPUB. Parsed first, both would be refused for that — and a
    // thousand-chapter volume is seconds of work to do and throw away. The answer that matters is
    // the one about where the volume was going.
    const junk = () =>
      new File(["this is not a zip"], "vol.epub", { type: "application/epub+zip" });
    const missing = await api.import<{ error: { message: string } }>(junk(), { bookId: "no-such" });
    expect(missing.status).toBe(404);
    const waiting = await api.import<{ error: { message: string } }>(junk(), { bookId: id });
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.message).toContain("already has a volume waiting");
  });

  test("removing a middle volume renumbers what is left", async () => {
    const api = testApi();
    const first = await api.import<ImportResult>(await volume(["One", "Two"]));
    const id = first.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    for (const titles of [["Three"], ["Four", "Five"]]) {
      await api.import<ImportResult>(await volume(titles), { bookId: id });
      await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    }

    const removed = await api.request<{ removed: string; chapters: number }>(
      `/api/books/${id}/volumes/2`,
      { method: "DELETE" },
    );
    expect(removed.body).toEqual({ removed: "volume", chapters: 1 });

    const after = await api.request<ImportResult>(`/api/books/${id}`);
    // a gap in the numbering would strand every script, job and export entry keyed by the old number
    expect(after.body.chapters.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(after.body.chapters.map((c) => c.title)).toEqual(["One", "Two", "Four", "Five"]);
    expect(after.body.book.volumes.map((v) => [v.from, v.to])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("a renumbered chapter keeps its own text", async () => {
    const api = testApi();
    const first = await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "One", paragraphs: ["The first volume."] }] }),
    );
    const id = first.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Two", paragraphs: ["The second volume."] }] }),
      { bookId: id },
    );
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });

    await api.request(`/api/books/${id}/volumes/1`, { method: "DELETE" });
    const after = await api.request<ImportResult>(`/api/books/${id}`);
    expect(after.body.chapters.map((c) => c.id)).toEqual([1]);
    // chapter 2's text has to move with it to chapter 1, or the book reads as the wrong volume
    const text = await api.request<{ text: string }>(`/api/books/${id}/chapters/1/text`);
    expect(text.body.text).toContain("The second volume.");
  });

  test("removing the last volume removes the book", async () => {
    const api = testApi();
    const first = await api.import<ImportResult>(await volume(["One"]));
    const id = first.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });

    const removed = await api.request<{ removed: string }>(`/api/books/${id}/volumes/1`, {
      method: "DELETE",
    });
    expect(removed.body.removed).toBe("book");
    const list = await api.request<{ books: Book[] }>("/api/books");
    expect(list.body.books).toHaveLength(0);
  });

  test("removing a book takes its chapters and their text with it", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(await volume(["One", "Two"]));
    await api.request(`/api/books/${body.book.id}`, { method: "DELETE" });

    const gone = await api.request(`/api/books/${body.book.id}`);
    expect(gone.status).toBe(404);
    const text = await api.request(`/api/books/${body.book.id}/chapters/1/text`);
    expect(text.status).toBe(404);
  });
});

describe("routes that are asked for something that is not there", () => {
  test("a book that does not exist is a 404, not an empty book", async () => {
    const api = testApi();
    const { status, body } = await api.request<{ error: { message: string } }>("/api/books/nope");
    expect(status).toBe(404);
    expect(body.error.message).toBe("No such book");
  });

  test("a chapter list with no ids in it is refused, in the API's own error shape", async () => {
    const { api, book } = await imported();
    const { status, body } = await api.request<{ error: { message: string; detail?: string } }>(
      `/api/books/${book.id}/chapters/skip`,
      jsonBody({ ids: [] }),
    );
    expect(status).toBe(400);
    // The validator answers with its own `{success,error,data}` unless it is told not to, and a
    // client reading `error.message` finds nothing in it but "Request failed (400)".
    expect(body.error.message).toContain("not valid");
    expect(body.error.detail?.length).toBeGreaterThan(0);
  });

  test("a body that is not the right shape says which field was wrong", async () => {
    const { api, book } = await imported();
    const { status, body } = await api.request<{ error: { message: string; detail?: string } }>(
      `/api/books/${book.id}/chapters/skip`,
      jsonBody({ ids: ["one"] }),
    );
    expect(status).toBe(400);
    expect(body.error.detail).toContain("ids.0");
  });

  test("an unknown route says which one it was", async () => {
    const api = testApi();
    const { status, body } = await api.request<{ error: { message: string } }>("/api/nothing");
    expect(status).toBe(404);
    expect(body.error.message).toContain("/api/nothing");
  });
});
