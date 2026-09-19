// Finished audiobooks over HTTP: listed per book, one at a time, and forgotten. Nothing on this
// server builds one yet, so the rows are written the way the round-trip test writes them.
import { describe, expect, test } from "bun:test";

import type { Book, Chapter, ExportItem } from "@/types";
import { makeWorld } from "@/mock";
import { epubFile, story } from "../support/epub";
import { writeExport } from "../support/persist";
import { testApi } from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}

/** A shelved book, and a seeded export re-keyed onto it. */
async function withExport() {
  const api = testApi();
  const { body } = await api.import<ImportResult>(
    await epubFile({
      chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: story() })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  const seeded = makeWorld().exports.find((e) => e.status === "done" && e.chapterIds.length <= 3)!;
  const exported: ExportItem = {
    ...seeded,
    id: 1,
    bookId: id,
    chapterIds: [1, 2],
    files: seeded.files.slice(0, 1).map((f) => ({ ...f, chapterIds: [1, 2] })),
    state: { 1: "a", 2: "b" },
    timeline: [
      { id: 1, title: "One", duration: 100 },
      { id: 2, title: "Two", duration: 120 },
    ],
    replaces: null,
    version: 1,
  };
  delete exported.jobId;
  writeExport(api.db, exported, Date.parse(seeded.createdAt));
  return { api, id, exported };
}

describe("a book's exports over HTTP", () => {
  test("are listed with the chapters and files they were built from", async () => {
    const { api, id, exported } = await withExport();
    const { body } = await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`);
    expect(body.exports).toHaveLength(1);
    expect(body.exports[0]).toMatchObject({
      id: 1,
      bookId: id,
      chapterIds: [1, 2],
      state: { 1: "a", 2: "b" },
      timeline: exported.timeline,
    });
    const one = await api.request<{ export: ExportItem }>(`/api/books/${id}/exports/1`);
    expect(one.body.export.id).toBe(1);
  });

  test("an export of another book is not found through this one", async () => {
    const { api } = await withExport();
    const other = await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Solo", paragraphs: story() }] }),
    );
    const { status } = await api.request<Failure>(`/api/books/${other.body.book.id}/exports/1`);
    expect(status).toBe(404);
  });

  test("forgetting one takes it off the list, and a second try is a 404", async () => {
    const { api, id } = await withExport();
    const gone = await api.request<{ removed: number }>(`/api/books/${id}/exports/1`, {
      method: "DELETE",
    });
    expect(gone.body.removed).toBe(1);
    expect(
      (await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`)).body.exports,
    ).toEqual([]);
    expect(
      (await api.request<Failure>(`/api/books/${id}/exports/1`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  test("removing a volume takes the chapters an export claimed off it", async () => {
    const { api, id } = await withExport();
    await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Four", paragraphs: story() }] }),
      { bookId: id },
    );
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/volumes/1`, { method: "DELETE" });
    const { body } = await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`);
    // the export row stays, with no chapters left in it: what the client makes of that is its own
    expect(body.exports[0].chapterIds).toEqual([]);
  });
});
