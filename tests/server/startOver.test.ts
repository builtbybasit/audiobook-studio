// Starting a book over: every script and clip goes so the book can be scripted afresh, and each
// script waits in its chapter's history in case the new run comes out worse.
import { describe, expect, test } from "bun:test";

import type { Chapter, ChapterHistory, ChapterScript, Character, StartedOver } from "@/types";
import { epubFile, line } from "../support/epub";
import {
  gatedProvider,
  jsonBody,
  narratedBook,
  scriptChapters,
  testApi,
  type TestApi,
} from "../support/server";

const TWO: [string, string][] = [
  ["One", line("One")],
  ["Two", line("Two")],
];

const startOver = (api: TestApi, id: string, body: { cast?: boolean } = {}) =>
  api.request<StartedOver>(`/api/books/${id}/start-over`, jsonBody(body));

const script = async (api: TestApi, id: string, ch: number) =>
  (await api.request<ChapterScript>(`/api/books/${id}/chapters/${ch}/script`)).body;

const castOf = async (api: TestApi, id: string) =>
  (await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`)).body.characters.map(
    (c) => c.name,
  );

/** The files a book's scripts play, by name under its audio directory. */
async function clipFiles(api: TestApi, id: string, chapters: number[]): Promise<string[]> {
  const out: string[] = [];
  for (const ch of chapters)
    for (const s of (await script(api, id, ch)).segments)
      if (s.audio.url) out.push(s.audio.url.split("/").at(-1)!);
  return out;
}

/** The removal is not waited for by the route, so wait for the files here. */
async function gone(api: TestApi, id: string, files: string[]): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const left = await Promise.all(files.map((f) => Bun.file(api.files.path(id, f)!).exists()));
    if (!left.some(Boolean)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("starting a book over", () => {
  test("leaves every chapter as the import did, and removes the clips from disk", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: TWO });
    const files = await clipFiles(api, id, [1, 2]);
    expect(files.length).toBeGreaterThan(0);

    const { status, body } = await startOver(api, id);
    expect(status).toBe(200);
    expect(body.cleared).toEqual({ scripts: 2, clips: files.length, speakers: 0 });
    expect(
      body.chapters.map((c: Chapter) => [c.scripting, c.narration, c.duration, c.lines?.total]),
    ).toEqual([
      ["none", "none", 0, 0],
      ["none", "none", 0, 0],
    ]);
    expect((await script(api, id, 1)).segments).toEqual([]);
    expect(await gone(api, id, files)).toBe(true);
    // the speakers stay unless asked to go
    expect(await castOf(api, id)).toContain("Mara");
  });

  test("keeps each script in its chapter's history, where a run after it finds it", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: TWO });
    const before = (await script(api, id, 1)).segments.map((s) => s.text);

    await startOver(api, id);
    await scriptChapters(api, id, [1]);

    const { history } = (
      await api.request<{ history: ChapterHistory }>(`/api/books/${id}/chapters/1/history`)
    ).body;
    const kept = history.versions.at(-1)!;
    expect(kept.origin.kind).toBe("scripted");
    expect(kept.segments.map((s) => s.text)).toEqual(before);
    // the run that followed is a first script, not a re-script of nothing
    expect(history.head.origin).toMatchObject({ kind: "scripted" });
  });

  test("takes every speaker but the Narrator with it when asked", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: TWO });
    expect(await castOf(api, id)).toContain("Mara");

    const { body } = await startOver(api, id, { cast: true });
    expect(body.cleared.speakers).toBeGreaterThan(0);
    expect(await castOf(api, id)).toEqual(["Narrator"]);
  });

  test("is refused while a job of the book is running, and changes nothing", async () => {
    const gated = gatedProvider();
    const api = testApi({ scripting: gated.provider });
    const imported = await api.import<{ book: { id: string } }>(
      await epubFile({ chapters: TWO.map(([title, l]) => ({ title, paragraphs: [l] })) }),
    );
    const id = imported.body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
    await gated.started;

    const { status, body } = await startOver(api, id);
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toContain("still queued or running");

    gated.release();
    await api.runner.idle();
    expect((await script(api, id, 1)).segments.map((s) => s.text)).toEqual(["Rain fell."]);
  });
});
