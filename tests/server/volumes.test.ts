// Removing a volume from a book whose chapters have work and files attached.
//
// Removing a volume renumbers every chapter after it, and most of what hangs off a chapter follows
// through a foreign key. These are the parts that did not: the duplicate key a live job is found
// by, the clips those chapters rendered, an audiobook left with nothing in it, and a build that
// would have recorded where each chapter landed under numbers that no longer mean the same thing.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Book } from "@/types";
import * as queue from "~/db/jobs";
import type { Runner } from "~/jobs/runner";
import { AppError } from "~/lib/errors";
import * as ops from "~/library/ops";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

// A few paragraphs a chapter: the narrated test renders every line, and more lines prove nothing more.
const chapters = (...titles: string[]) =>
  epubFile({ chapters: titles.map((title) => ({ title, paragraphs: story(3) })) });

/** A book of two volumes: chapters 1–3, then 4–6. */
async function twoVolumes(api: TestApi = testApi()) {
  const { body } = await api.import<{ book: Book }>(await chapters("One", "Two", "Three"));
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.import(await chapters("Four", "Five", "Six"), { bookId: id });
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  return { api, id };
}

const narrate = (id: string, chapterId: number) => ({
  kind: "narration" as const,
  bookId: id,
  chapterId,
  label: `Narrate ${chapterId}`,
});

describe("removing a volume with work queued on the book", () => {
  test("a job on a chapter that stays is found by its new number, and only by that", async () => {
    const { api, id } = await twoVolumes();
    // Queued straight into the table, with no worker to pick it up, so it waits as asked.
    const { job } = queue.enqueueJob(api.db, narrate(id, 5));

    await ops.removeVolume(api.db, id, 1);

    const moved = queue.getJob(api.db, job.id)!;
    expect(moved.chapterId).toBe(2);
    // Asked for again under its new number, it is the same job rather than a second one paid
    // for beside it; and the chapter that now has its old number is not busy.
    expect(queue.activeJob(api.db, "narration", id, 2)?.id).toBe(job.id);
    expect(queue.enqueueJob(api.db, narrate(id, 2)).created).toBe(false);
    expect(queue.activeJob(api.db, "narration", id, 5)).toBeUndefined();
  });

  test("keys that trade places are written without colliding", async () => {
    // Six chapters after the removal of a three-chapter volume: 7→4 and 10→7 both move, and the
    // second takes the key the first is giving up.
    const api = testApi();
    const { id } = await twoVolumes(api);
    await api.import(await chapters("Seven", "Eight", "Nine", "Ten"), { bookId: id });
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    // Queued in this order so the later chapter is rekeyed first, onto a key still held.
    const b = queue.enqueueJob(api.db, narrate(id, 10)).job;
    const a = queue.enqueueJob(api.db, narrate(id, 7)).job;

    await ops.removeVolume(api.db, id, 1);

    expect(queue.activeJob(api.db, "narration", id, 4)?.id).toBe(a.id);
    expect(queue.activeJob(api.db, "narration", id, 7)?.id).toBe(b.id);
  });

  test("work on the chapters that go is cancelled first, and work on the rest is not", async () => {
    const { api, id } = await twoVolumes();
    const going = queue.enqueueJob(api.db, narrate(id, 2)).job;
    const staying = queue.enqueueJob(api.db, narrate(id, 5)).job;
    const cancelled: number[] = [];
    const runner = {
      cancel: (job: number) => (cancelled.push(job), "queued"),
    } as unknown as Runner;

    await ops.removeVolume(api.db, id, 1, { runner });

    expect(cancelled).toEqual([going.id]);
    expect(queue.getJob(api.db, staying.id)?.status).toBe("queued");
  });

  test("is refused while an audiobook of the book is being built", async () => {
    const { api, id } = await twoVolumes();
    queue.enqueueJob(api.db, { kind: "export", bookId: id, chapterId: null, label: "Build" });

    const e = await ops.removeVolume(api.db, id, 1).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(409);
    // and nothing moved
    const { body } = await api.request<{ chapters: unknown[] }>(`/api/books/${id}`);
    expect(body.chapters).toHaveLength(6);
  });
});

describe("removing a volume whose chapters were narrated", () => {
  test("takes the clips they rendered off the disk, and leaves the rest", async () => {
    const { api, id } = await twoVolumes();
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 5] }));
    await api.runner.idle();
    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1, 5] }));
    await api.runner.idle();
    const dir = join(api.audioDir, id);
    const before = readdirSync(dir);
    expect(before.length).toBeGreaterThan(1);

    const clipsOf = async (chapter: number) => {
      const { body } = await api.request<{ segments: { audio: { url?: string } }[] }>(
        `/api/books/${id}/chapters/${chapter}/script`,
      );
      return body.segments.flatMap((s) => (s.audio.url ? [s.audio.url.split("/").at(-1)!] : []));
    };
    const first = await clipsOf(1);
    const fifth = await clipsOf(5);
    expect(first.length).toBeGreaterThan(0);

    const res = await api.request(`/api/books/${id}/volumes/1`, { method: "DELETE" });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && first.some((f) => existsSync(join(dir, f))); i++)
      await new Promise((r) => setTimeout(r, 2));

    for (const f of first) expect(existsSync(join(dir, f))).toBe(false);
    // chapter 5 is chapter 2 now, and its audio is where it was
    expect(await clipsOf(2)).toEqual(fifth);
    for (const f of fifth) expect(existsSync(join(dir, f))).toBe(true);
  });
});
