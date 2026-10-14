// Re-apply: clips whose sound no longer matches their line's effects, counted and remade from the
// voice's raw files: swapped clip by clip, raw files kept, old processed files removed, a clip
// changed mid-job left alone, a failure noted without stopping the rest. The effect runner is the
// WAV-copying fake (`tests/support/effects.ts`).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { Job, StaleSound, Step } from "@/types";
import { soundOf } from "@/lib/effects";
import { newSpeaker } from "@/lib/cast";
import { createEffect } from "~/db/effects";
import { characterValues } from "~/db/rows/cast";
import { listJobs } from "~/db/jobs";
import { clips, characters, segments } from "~/db/schema";
import { readScript } from "~/db/script";
import { and, eq } from "drizzle-orm";
import { fakeEffectRunner, type FakeEffectRunner } from "../support/effects";
import { line } from "../support/epub";
import { jsonBody, narratedBook, testApi, type TestApi } from "../support/server";

const echo: Step[] = [{ plugin: "Delay", params: { delay_seconds: 0.25 }, on: true }];
const louder: Step[] = [{ plugin: "Gain", params: { gain_db: 3 }, on: true }];

/** A book of two narrated chapters, Mara speaking in each; its id. */
async function book(fake: FakeEffectRunner = fakeEffectRunner()) {
  const api = testApi({ effects: fake });
  const { id } = await narratedBook(api, {
    chapters: [
      ["One", line("One")],
      ["Two", line("Two")],
    ],
  });
  return { api, id, fake };
}

const wear = (api: TestApi, id: string, effect: string | null) =>
  api.db
    .update(characters)
    .set({ effect })
    .where(and(eq(characters.bookId, id), eq(characters.name, "Mara")))
    .run();

/** Every line's clip in the book, as the script reads it. */
const lines = (api: TestApi, id: string) =>
  [1, 2].flatMap((ch) => readScript(api.db, id, ch).map((s) => ({ ch, ...s })));
const maras = (api: TestApi, id: string) => lines(api, id).filter((s) => s.speaker === "Mara");

const stale = async (api: TestApi, id: string) =>
  (await api.request<StaleSound>(`/api/books/${id}/effects/stale`)).body;

/** Queue the book's Re-apply and wait for it; the job as it ended. */
async function reapply(api: TestApi, id: string): Promise<Job> {
  const { status, body } = await api.request<{ job: Job }>(
    `/api/books/${id}/effects/reapply`,
    jsonBody({}),
  );
  expect(status).toBe(202);
  await api.runner.idle();
  return listJobs(api.db, { bookId: id }).find((j) => j.id === body.job.id)!;
}

const onDisk = (api: TestApi, id: string): string[] => readdirSync(join(api.audioDir, id)).sort();
const fileOf = (url: string | null | undefined) => url!.split("/").at(-1)!;

/** Write a clip's url-keyed state straight onto its row. */
const setClip = (
  api: TestApi,
  url: string,
  set: { raw?: string | null; sound?: string | null; url?: string },
) => api.db.update(clips).set(set).where(eq(clips.url, url)).run();

describe("what has an old sound", () => {
  test("a clip whose line's effects changed, went, or cannot be redone", async () => {
    const { api, id } = await book();
    expect(await stale(api, id)).toEqual({ lines: 0, unavailable: 0, ready: true });

    // Mara wears an effect her clips were made without
    const e = createEffect(api.db, "echo", { name: "Echo", chain: echo });
    wear(api, id, e.id);
    const [a, b] = maras(api, id);
    expect(await stale(api, id)).toEqual({ lines: 2, unavailable: 0, ready: true });

    // one is processed as she now sounds; the other as she used to
    setClip(api, a.audio.url!, { sound: soundOf([e]), raw: "/api/audio/x/raw-a.wav" });
    setClip(api, b.audio.url!, { sound: "0ld50und", raw: "/api/audio/x/raw-b.wav" });
    expect(await stale(api, id)).toEqual({ lines: 1, unavailable: 0, ready: true });

    // she wears nothing now: both go back to their raw files
    wear(api, id, null);
    expect(await stale(api, id)).toEqual({ lines: 2, unavailable: 0, ready: true });

    // an ffmpeg thought clip with no raw file cannot be undone
    setClip(api, b.audio.url!, { sound: "ffmpeg", raw: null });
    expect(await stale(api, id)).toEqual({ lines: 2, unavailable: 1, ready: true });
  });

  test("a clip whose line gained a line effect, or whose speaker became a persona", async () => {
    const { api, id } = await book();
    const e = createEffect(api.db, "phone", { name: "Phone", chain: echo });
    const [a, b] = maras(api, id);
    api.db
      .update(segments)
      .set({ effects: [e.id] })
      .where(and(eq(segments.bookId, id), eq(segments.chapterId, a.ch), eq(segments.id, a.id)))
      .run();
    expect(await stale(api, id)).toEqual({ lines: 1, unavailable: 0, ready: true });
    // made as it now sounds, it is not old; its neighbour with no line effect never was
    setClip(api, a.audio.url!, { sound: soundOf([e]), raw: "/api/audio/x/raw-a.wav" });
    expect(await stale(api, id)).toEqual({ lines: 0, unavailable: 0, ready: true });

    // Mara becomes a persona of a speaker who wears an effect: hers go first, on every line
    const louderFx = createEffect(api.db, "louder", { name: "Louder", chain: louder });
    api.db
      .insert(characters)
      .values(characterValues(id, { ...newSpeaker("Ann", 1), effect: louderFx.id }, 99))
      .run();
    api.db
      .update(characters)
      .set({ personaOf: "Ann" })
      .where(and(eq(characters.bookId, id), eq(characters.name, "Mara")))
      .run();
    expect(await stale(api, id)).toEqual({ lines: 2, unavailable: 0, ready: true });
    setClip(api, a.audio.url!, { sound: soundOf([louderFx, e]) });
    setClip(api, b.audio.url!, { sound: soundOf([louderFx]), raw: "/api/audio/x/raw-b.wav" });
    expect(await stale(api, id)).toEqual({ lines: 0, unavailable: 0, ready: true });
  });

  test("says whether effects can run here to redo them", async () => {
    const fake = fakeEffectRunner();
    const { api, id } = await book(fake);
    expect((await stale(api, id)).ready).toBe(true);
    fake.ready = false;
    expect((await stale(api, id)).ready).toBe(false);

    const bare = testApi();
    const { id: other } = await narratedBook(bare, { chapters: [["One", line("One")]] });
    expect((await stale(bare, other)).ready).toBe(false);
  });

  test("an unknown book is a 404", async () => {
    const api = testApi();
    expect((await api.request("/api/books/nope/effects/stale")).status).toBe(404);
  });
});

describe("re-applying", () => {
  test("renders from the raw files, swaps them in, and removes what it replaced", async () => {
    const { api, id, fake } = await book();
    const raws = maras(api, id).map((s) => s.audio.url!);
    const before = onDisk(api, id);

    const e = createEffect(api.db, "echo", { name: "Echo", chain: echo });
    wear(api, id, e.id);
    expect((await reapply(api, id)).status).toBe("done");
    expect(fake.calls.batch).toHaveLength(1);
    expect(fake.calls.batch[0].map((j) => j.chains)).toEqual([[echo], [echo]]);
    expect(fake.calls.batch[0].map((j) => j.input.split("/").at(-1))).toEqual(raws.map(fileOf));
    const first = maras(api, id);
    expect(first.map((s) => s.audio.raw)).toEqual(raws);
    expect(first.map((s) => s.audio.sound ?? null)).toEqual([soundOf([e]), soundOf([e])]);
    expect(first.every((s) => s.audio.duration > 0)).toBe(true);
    expect(first.map((s) => s.audio.url)).not.toEqual(raws);
    // the voice's files stay, beside the new ones
    expect(onDisk(api, id)).toEqual([...before, ...first.map((s) => fileOf(s.audio.url))].sort());
    expect(await stale(api, id)).toEqual({ lines: 0, unavailable: 0, ready: true });

    // the effect changes: made again from the raw files, the first renders gone
    wear(api, id, createEffect(api.db, "louder", { name: "Louder", chain: louder }).id);
    expect((await reapply(api, id)).status).toBe("done");
    expect(fake.calls.batch[1].map((j) => fileOf(j.input))).toEqual(raws.map(fileOf));
    const second = maras(api, id);
    expect(second.map((s) => s.audio.raw)).toEqual(raws);
    expect(onDisk(api, id)).toEqual([...before, ...second.map((s) => fileOf(s.audio.url))].sort());

    // and taken off: the raw files are the clips again, with nothing rendered
    wear(api, id, null);
    expect((await reapply(api, id)).status).toBe("done");
    expect(fake.calls.batch).toHaveLength(2);
    const third = maras(api, id);
    expect(third.map((s) => s.audio.url)).toEqual(raws);
    expect(third.map((s) => [s.audio.raw, s.audio.sound])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(onDisk(api, id)).toEqual(before);
  });

  test("leaves a clip re-narrated while it ran, and notes one that failed", async () => {
    const fake = fakeEffectRunner();
    const { api, id } = await book(fake);
    const before = onDisk(api, id);
    const [a, b] = maras(api, id);
    wear(api, id, createEffect(api.db, "echo", { name: "Echo", chain: echo }).id);

    // the first clip is narrated again while the batch runs; the second fails in it
    const batch = fake.batch.bind(fake);
    let refused = 0;
    fake.batch = async (jobs, each, signal) => {
      setClip(api, a.audio.url!, { url: "/api/audio/x/again.wav" });
      // one Re-apply per book at a time
      refused = (await api.request(`/api/books/${id}/effects/reapply`, jsonBody({}))).status;
      await batch(jobs, (i, error) => each(i, i === 1 ? "Pedalboard fell over" : error), signal);
    };
    const job = await reapply(api, id);
    expect(refused).toBe(409);
    expect(job.status).toBe("failed");
    expect(job.activity?.some((e) => e.detail?.error === "Pedalboard fell over")).toBe(true);

    const [a2, b2] = maras(api, id);
    expect(a2.audio.url).toBe("/api/audio/x/again.wav");
    expect(b2.audio.url).toBe(b.audio.url);
    expect(b2.audio.sound).toBeUndefined();
    // neither render is kept, and nothing of the book's was removed
    expect(onDisk(api, id)).toEqual(before);
  });

  test("fails, saying why, where effects cannot run", async () => {
    const fake = fakeEffectRunner();
    fake.ready = false;
    const { api, id } = await book(fake);
    wear(api, id, createEffect(api.db, "echo", { name: "Echo", chain: echo }).id);
    const job = await reapply(api, id);
    expect(job.status).toBe("failed");
    expect(job.activity?.at(-1)?.detail?.error).toContain("cannot run on this machine");
  });
});

describe("removing clips", () => {
  test("takes their raw files with them", async () => {
    const { api, id } = await book();
    wear(api, id, createEffect(api.db, "echo", { name: "Echo", chain: echo }).id);
    await reapply(api, id);
    expect(maras(api, id).every((s) => s.audio.raw)).toBe(true);
    await api.request(`/api/books/${id}/start-over`, jsonBody({}));
    // removed without being waited for
    for (let i = 0; i < 50 && onDisk(api, id).length; i++) await Bun.sleep(10);
    expect(onDisk(api, id)).toEqual([]);
  });
});
