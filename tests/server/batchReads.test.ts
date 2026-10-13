// Several chapters' prose or scripts in one read (`GET /books/:id/texts`, `/scripts`): what a page
// that prices or reads hundreds of chapters asks for instead of one request each. Each chapter in
// the answer is what its own route gives; a chapter the book does not have is left out.
import { expect, test } from "bun:test";

import type { Book, ChapterScript } from "@/types";
import { epubFile, story } from "../support/epub";
import { testApi } from "../support/server";

async function book() {
  const api = testApi();
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: story(2) })),
    }),
  );
  return { api, id: body.book.id };
}

const ids = (...n: number[]) => n.map((i) => `id=${i}`).join("&");

test("each chapter's prose is what its own route gives, in either format", async () => {
  const { api, id } = await book();
  for (const format of ["markdown", "plain"] as const) {
    const { status, body } = await api.request<{ texts: Record<number, string> }>(
      `/api/books/${id}/texts?format=${format}&${ids(1, 3, 99)}`,
    );
    expect(status).toBe(200);
    // 99 is not a chapter of the book, and is left out
    expect(Object.keys(body.texts)).toEqual(["1", "3"]);
    for (const n of [1, 3]) {
      const one = await api.request<{ text: string }>(
        `/api/books/${id}/chapters/${n}/text?format=${format}`,
      );
      expect(body.texts[n]).toBe(one.body.text);
    }
  }
});

test("each chapter's script is what its own route gives", async () => {
  const { api, id } = await book();
  const { status, body } = await api.request<{ scripts: Record<number, ChapterScript> }>(
    `/api/books/${id}/scripts?${ids(2, 99)}`,
  );
  expect(status).toBe(200);
  expect(Object.keys(body.scripts)).toEqual(["2"]);
  const one = await api.request<ChapterScript>(`/api/books/${id}/chapters/2/script`);
  expect(body.scripts[2]).toEqual(one.body);
});

test("a read naming no chapter, too many or not a number is refused; one in no book is not found", async () => {
  const { api, id } = await book();
  for (const route of ["texts", "scripts"]) {
    expect((await api.request(`/api/books/${id}/${route}`)).status).toBe(400);
    expect((await api.request(`/api/books/${id}/${route}?id=x`)).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => i + 1);
    expect((await api.request(`/api/books/${id}/${route}?${ids(...many)}`)).status).toBe(400);
    expect((await api.request(`/api/books/no-such-book/${route}?id=1`)).status).toBe(404);
  }
});
