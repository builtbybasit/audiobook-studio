// A book's settings and its volumes' names and order, written on the server.
//
// Until these routes the budget, the pacing and a volume's name and place were the browser's alone,
// and the next read of the book put the stored ones back over them. Each test here writes through
// the route and reads the book again, because a read is what a reload does. The reorder is the same
// renumbering a removal makes, so it is held to the same account: everything a chapter owns — its
// text, its script, a job queued on it — answers to its new number and not to its old one.
import { describe, expect, test } from "bun:test";

import type { Book, Chapter } from "@/types";
import { DEFAULT_PACING, silenceOf } from "@/lib/speech";
import * as queue from "~/db/jobs";
import { readScript } from "~/db/script";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

interface BookResult {
  book: Book;
  chapters: Chapter[];
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}

const chapters = (...titles: string[]) =>
  epubFile({
    chapters: titles.map((title) => ({
      title,
      paragraphs: ["“We are short again,” said Mara.", ...story(2)],
    })),
  });

const send = <T = BookResult>(api: TestApi, path: string, method: string, body: unknown) =>
  api.request<T>(path, { ...jsonBody(body), method });

const patch = <T = BookResult>(api: TestApi, id: string, body: unknown) =>
  send<T>(api, `/api/books/${id}`, "PATCH", body);

const reorder = <T = BookResult>(api: TestApi, id: string, order: number[]) =>
  send<T>(api, `/api/books/${id}/volumes/order`, "PUT", { order });

const read = async (api: TestApi, id: string) =>
  (await api.request<BookResult>(`/api/books/${id}`)).body;

/** A book of two volumes: chapters 1–2, then 3–5. */
async function twoVolumes(api: TestApi = testApi()) {
  const { body } = await api.import<{ book: Book }>(await chapters("One", "Two"));
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.import(await chapters("Three", "Four", "Five"), { bookId: id, name: "Vol. 2" });
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  return { api, id };
}

describe("a book's settings", () => {
  test("a budget, a script budget and a pacing are there on the next read", async () => {
    const { api, id } = await twoVolumes();
    const { status, body } = await patch(api, id, {
      budget: { cap: 12.5, paused: true },
      scriptBudget: 3,
      pacing: { line: 0.5, turn: 1.2 },
    });
    expect(status).toBe(200);
    expect(body.book).toMatchObject({
      budget: { cap: 12.5, paused: true },
      scriptBudget: 3,
      pacing: { line: 0.5, turn: 1.2 },
    });
    expect((await read(api, id)).book).toMatchObject(body.book);
  });

  test("a setting left out is left alone, and null clears one", async () => {
    const { api, id } = await twoVolumes();
    await patch(api, id, { budget: { cap: 10, paused: false }, pacing: { line: 0.2, turn: 0.4 } });

    await patch(api, id, { budget: { cap: 10, paused: true } });
    let { book } = await read(api, id);
    expect(book.budget).toEqual({ cap: 10, paused: true });
    expect(book.pacing).toEqual({ line: 0.2, turn: 0.4 });

    // the default pacing is the absence of one, not a copy of the default
    await patch(api, id, { pacing: null, budget: null });
    ({ book } = await read(api, id));
    expect(book.pacing).toBeUndefined();
    expect(book.budget).toBeUndefined();
  });

  test("a budget with no cap is still a pause", async () => {
    const { api, id } = await twoVolumes();
    await patch(api, id, { budget: { cap: null, paused: true } });
    expect((await read(api, id)).book.budget).toEqual({ cap: null, paused: true });
  });

  test("refuses a setting it does not know, a negative amount, an empty request and a book that is not there", async () => {
    const { api, id } = await twoVolumes();
    const unknown = await patch<Failure>(api, id, { title: "Another" });
    expect(unknown.status).toBe(400);
    expect((await patch<Failure>(api, id, { scriptBudget: -1 })).status).toBe(400);
    expect((await patch<Failure>(api, id, { pacing: { line: 0.2 } })).status).toBe(400);
    expect((await patch<Failure>(api, id, {})).status).toBe(400);
    const missing = await patch<Failure>(api, "nobody", { scriptBudget: 1 });
    expect(missing.status).toBe(404);
    // and nothing was written by any of them
    expect((await read(api, id)).book.scriptBudget).toBeUndefined();
  });

  test("a pacing re-times the chapters that were narrated, and leaves the rest as they were", async () => {
    const { api, id } = await twoVolumes();
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 2] }));
    await api.runner.idle();
    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1] }));
    await api.runner.idle();
    const before = (await read(api, id)).chapters;
    const segs = readScript(api.db, id, 1);
    const spoken = segs.reduce((n, s) => n + s.audio.duration, 0);
    expect(before[0].duration).toBeCloseTo(spoken + silenceOf(segs, DEFAULT_PACING), 6);

    const pacing = { line: 2, turn: 3 };
    const { body } = await patch(api, id, { pacing });
    expect(body.chapters[0].duration).toBeCloseTo(spoken + silenceOf(segs, pacing), 6);
    expect(body.chapters[0].duration).toBeGreaterThan(before[0].duration);
    // scripted but never narrated: no clips to put silence between
    expect(body.chapters[1].duration).toBe(before[1].duration);
    expect((await read(api, id)).chapters[0].duration).toBe(body.chapters[0].duration);
  });
});

describe("a volume's name", () => {
  test("is there on the next read, trimmed, and nothing is renumbered", async () => {
    const { api, id } = await twoVolumes();
    const { status, body } = await send<{ book: Book }>(
      api,
      `/api/books/${id}/volumes/2`,
      "PATCH",
      { name: "  Book Two " },
    );
    expect(status).toBe(200);
    expect(body.book.volumes.map((v) => v.name)[1]).toBe("Book Two");
    const after = await read(api, id);
    expect(after.book.volumes[1].name).toBe("Book Two");
    expect(after.chapters.map((c) => c.title)).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  test("refuses a blank name and a volume that is not there", async () => {
    const { api, id } = await twoVolumes();
    const blank = await send<Failure>(api, `/api/books/${id}/volumes/2`, "PATCH", { name: "  " });
    expect(blank.status).toBe(400);
    const missing = await send<Failure>(api, `/api/books/${id}/volumes/9`, "PATCH", { name: "X" });
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe("No such volume");
  });
});

describe("a volume's place in the book", () => {
  test("moving one renumbers the chapters to follow, each keeping its place in its volume", async () => {
    const { api, id } = await twoVolumes();
    const { status, body } = await reorder(api, id, [2, 1]);
    expect(status).toBe(200);
    expect(body.book.volumes.map((v) => [v.id, v.from, v.to])).toEqual([
      [2, 1, 3],
      [1, 4, 5],
    ]);
    expect(body.chapters.map((c) => [c.id, c.title, c.volumeId, c.volumeIndex])).toEqual([
      [1, "Three", 2, 1],
      [2, "Four", 2, 2],
      [3, "Five", 2, 3],
      [4, "One", 1, 1],
      [5, "Two", 1, 2],
    ]);
    expect(await read(api, id)).toEqual(body);
  });

  test("a chapter's text, script and queued work answer to its new number", async () => {
    const { api, id } = await twoVolumes();
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
    await api.runner.idle();
    const script = readScript(api.db, id, 1);
    // queued straight into the table, with no worker to pick it up, so it waits as asked
    const { job } = queue.enqueueJob(api.db, {
      kind: "narration",
      bookId: id,
      chapterId: 1,
      label: "Narrate 1",
    });

    await reorder(api, id, [2, 1]);

    const text = await api.request<{ text: string }>(`/api/books/${id}/chapters/4/text`);
    expect(text.body.text).toContain("One");
    expect(readScript(api.db, id, 4)).toEqual(script);
    expect(readScript(api.db, id, 1)).toEqual([]);
    expect(queue.getJob(api.db, job.id)?.chapterId).toBe(4);
    expect(queue.activeJob(api.db, "narration", id, 4)?.id).toBe(job.id);
    expect(queue.activeJob(api.db, "narration", id, 1)).toBeUndefined();
  });

  test("moving it back puts every number back where it was", async () => {
    const { api, id } = await twoVolumes();
    const before = await read(api, id);
    await reorder(api, id, [2, 1]);
    await reorder(api, id, [1, 2]);
    expect(await read(api, id)).toEqual(before);
  });

  test("an order that does not name every volume once is refused, and nothing moves", async () => {
    const { api, id } = await twoVolumes();
    const before = await read(api, id);
    for (const order of [[2], [2, 2], [1, 2, 3], [3, 1]]) {
      const { status, body } = await reorder<Failure>(api, id, order);
      expect(status).toBe(400);
      expect(body.error.message).toBe("Name every volume of the book once");
    }
    expect(await read(api, id)).toEqual(before);
  });

  test("is refused while an audiobook of the book is being built", async () => {
    const { api, id } = await twoVolumes();
    queue.enqueueJob(api.db, { kind: "export", bookId: id, chapterId: null, label: "Build" });
    const { status, body } = await reorder<Failure>(api, id, [2, 1]);
    expect(status).toBe(409);
    expect(body.error.message).toContain("is being built");
    expect((await read(api, id)).chapters[0].title).toBe("One");
  });

  test("is refused while a volume is still in review", async () => {
    const { api, id } = await twoVolumes();
    await api.import(await chapters("Six"), { bookId: id, name: "Vol. 3" });
    const { status, body } = await reorder<Failure>(api, id, [3, 2, 1]);
    expect(status).toBe(409);
    expect(body.error.message).toContain("still in review");
  });
});
