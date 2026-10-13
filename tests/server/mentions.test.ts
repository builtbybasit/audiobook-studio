// Which chapters name a speaker (`GET /books/:id/mentions`): what the Cast page counts before it
// offers to re-script the chapters a persona turns up in. A name counts only as written — same
// case, a whole word — or "Shadow" would find every chapter with a shadow in it.
import { expect, test } from "bun:test";

import type { Book } from "@/types";
import { epubFile, story } from "../support/epub";
import { testApi } from "../support/server";

async function book() {
  const api = testApi();
  const paragraphs = (...said: string[]) => [...said, ...story(3)];
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      chapters: [
        { title: "One", paragraphs: paragraphs("“Kneel,” said the Lord of Shadows.") },
        { title: "Two", paragraphs: paragraphs("A shadow fell over Shadowfall.") },
        { title: "Three", paragraphs: paragraphs("“Again,” said Shadow, and Élan nodded.") },
      ],
    }),
  );
  return { api, id: body.book.id };
}

const mentions = (api: ReturnType<typeof testApi>, id: string, ...names: string[]) =>
  api.request<{ byName: Record<string, number[]> }>(
    `/api/books/${id}/mentions?${names.map((n) => `name=${encodeURIComponent(n)}`).join("&")}`,
  );

test("each name finds the chapters that name it as a whole word, in its own case", async () => {
  const { api, id } = await book();
  expect(await mentions(api, id, "Lord of Shadows")).toEqual({
    status: 200,
    body: { byName: { "Lord of Shadows": [1] } },
  });
  // not "shadow", not inside "Shadowfall" or "Shadows"
  expect((await mentions(api, id, "Shadow", "lord of shadows", "Élan")).body.byName).toEqual({
    Shadow: [3],
    "lord of shadows": [],
    Élan: [3],
  });
});

test("a search for nobody is refused, and one in no book is not found", async () => {
  const { api, id } = await book();
  expect((await api.request(`/api/books/${id}/mentions`)).status).toBe(400);
  expect((await mentions(api, id, " ")).status).toBe(400);
  expect((await mentions(api, "no-such-book", "Sunny")).status).toBe(404);
});
