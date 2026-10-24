// Listening on past the end of a chapter: the next kept chapter with audio, its script read from
// the server when no page has read it yet.
import { afterEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { chapterQueue, chapterQueueId, clipOf, lineUnder } from "@/composables/useChapterQueue";
import { fetchBook, fetchScript } from "@/queries";
import { useScriptsStore } from "@/stores/scripts";
import { chapters } from "~/db/schema";
import { backendServer, pointServicesAt } from "./support/backendServer";
import { line } from "./support/epub";
import { testPinia } from "./support/pinia";
import { narratedBook } from "./support/server";

afterEach(() => pointServicesAt(null));

test("the next queue is the next kept chapter, read though no page opened it", async () => {
  const api = backendServer();
  const { id } = await narratedBook(api, {
    chapters: [
      ["One", line("One")],
      ["Two", line("Two")],
      ["Three", line("Three")],
    ],
  });
  await api.runner.idle();
  api.db
    .update(chapters)
    .set({ excluded: true })
    .where(and(eq(chapters.bookId, id), eq(chapters.id, 2)))
    .run();
  testPinia();
  await fetchBook(id);
  await fetchScript(id, 1);

  const next = await chapterQueue(id, 1)!.next!();
  expect(next?.id).toBe(chapterQueueId(id, 3));
  expect(next?.clips.length).toBeGreaterThan(0);
  expect(useScriptsStore().segmentsOf(id, 2)).toEqual([]);
});

test.each([
  ["its own chapter's line", clipOf("b", 1, 42), 42],
  ["the same line id in another chapter", clipOf("b", 2, 42), null],
  ["another book's", clipOf("c", 1, 42), null],
  ["a take of the line", clipOf("b", 1, 42, "cand"), null],
  ["nothing playing", null, null],
])("lineUnder: %s", (_, clipId, want) => {
  expect(lineUnder(clipId, "b", 1)).toBe(want);
});
