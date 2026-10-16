// Re-apply: clips whose sound no longer matches their line's effects, counted and remade from the
// voice's raw files: swapped clip by clip, raw files kept, old processed files removed, a clip
// changed mid-job left alone, a failure noted without stopping the rest. The effect runner is the
// WAV-copying fake (`tests/support/effects.ts`).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { ExistingScope, Job, StaleSound, Step } from "@/types";
import { soundOf } from "@/lib/effects";
import { newSpeaker } from "@/lib/cast";
import { createEffect } from "~/db/effects";
import { characterValues } from "~/db/rows/cast";
import { getJob } from "~/db/jobs";
import { chapters, clips, characters, segments } from "~/db/schema";
import { readScript, writeScript } from "~/db/script";
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

const stale = async (api: TestApi, id: string, query = "") =>
  (await api.request<StaleSound>(`/api/books/${id}/effects/stale${query}`)).body;
/** Just the counts. */
const count = async (api: TestApi, id: string) => {
  const { lines, unavailable } = await stale(api, id);
  return { lines, unavailable };
};
const both = [
  { id: 1, lines: 1, unavailable: 0 },
  { id: 2, lines: 1, unavailable: 0 },
];

const keep = async (api: TestApi, id: string, scope: ExistingScope) =>
  (await api.request<{ kept: number }>(`/api/books/${id}/effects/keep`, jsonBody(scope))).body.kept;

/** Queue the book's Re-apply and wait for it; the job as it ended. */
async function reapply(api: TestApi, id: string, scope: ExistingScope = {}): Promise<Job> {
  const { status, body } = await api.request<{ job: Job }>(
    `/api/books/${id}/effects/reapply`,
    jsonBody(scope),
  );
  expect(status).toBe(202);
  await api.runner.idle();
  return getJob(api.db, body.job.id)!;
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
    expect(await stale(api, id)).toEqual({ lines: 0, unavailable: 0, ready: true, chapters: [] });

    // Mara wears an effect her clips were made without
    const e = createEffect(api.db, "echo", { name: "Echo", chain: echo });
    wear(api, id, e.id);
    const [a, b] = maras(api, id);
    expect(await stale(api, id)).toEqual({ lines: 2, unavailable: 0, ready: true, chapters: both });

    // one is processed as she now sounds; the other as she used to
    setClip(api, a.audio.url!, { sound: soundOf([e]), raw: "/api/audio/x/raw-a.wav" });
    setClip(api, b.audio.url!, { sound: "0ld50und", raw: "/api/audio/x/raw-b.wav" });
    expect(await count(api, id)).toEqual({ lines: 1, unavailable: 0 });

    // she wears nothing now: both go back to their raw files
    wear(api, id, null);
    expect(await count(api, id)).toEqual({ lines: 2, unavailable: 0 });

    // an ffmpeg thought clip with no raw file cannot be undone
    setClip(api, b.audio.url!, { sound: "ffmpeg", raw: null });
    expect(await stale(api, id)).toEqual({
      lines: 2,
      unavailable: 1,
      ready: true,
      chapters: [both[0], { id: 2, lines: 1, unavailable: 1 }],
    });
  });

  test("by chapter, for one speaker, leaving out an excluded chapter", async () => {
    const { api, id } = await book();
    wear(api, id, createEffect(api.db, "echo", { name: "Echo", chain: echo }).id);
    expect((await stale(api, id, "?speaker=Mara")).chapters).toEqual(both);
    expect(await stale(api, id, "?speaker=Narrator")).toMatchObject({ lines: 0, chapters: [] });

    api.db
      .update(chapters)
      .set({ excluded: true })
      .where(and(eq(chapters.bookId, id), eq(chapters.id, 1)))
      .run();
    expect(await stale(api, id)).toMatchObject({ lines: 1, chapters: [both[1]] });
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
    expect(await count(api, id)).toEqual({ lines: 1, unavailable: 0 });
    // made as it now sounds, it is not old; its neighbour with no line effect never was
    setClip(api, a.audio.url!, { sound: soundOf([e]), raw: "/api/audio/x/raw-a.wav" });
    expect(await count(api, id)).toEqual({ lines: 0, unavailable: 0 });

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
    expect(await count(api, id)).toEqual({ lines: 2, unavailable: 0 });
    // Ann's own ask takes in her persona's lines, which wear her effect
    expect((await stale(api, id, "?speaker=Ann")).lines).toBe(2);
    setClip(api, a.audio.url!, { sound: soundOf([louderFx, e]) });
    setClip(api, b.audio.url!, { sound: soundOf([louderFx]), raw: "/api/audio/x/raw-b.wav" });
    expect(await count(api, id)).toEqual({ lines: 0, unavailable: 0 });
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

  test.each([
    ["counted", undefined],
    ["kept", jsonBody({})],
  ])("an unknown book's cannot be %s", async (_, init) => {
    const api = testApi();
    const path = init ? "/api/books/nope/effects/keep" : "/api/books/nope/effects/stale";
    expect((await api.request(path, init)).status).toBe(404);
  });
});

describe("keeping the old sound", () => {
  test("holds against the effect it was kept under, through a script save", async () => {
    const { api, id } = await book();
    const e = createEffect(api.db, "echo", { name: "Echo", chain: echo });
    wear(api, id, e.id);
    expect(await keep(api, id, { chapters: [1, 99] })).toBe(1);
    expect((await stale(api, id)).chapters).toEqual([both[1]]);
    // a save rewrites the chapter's clip rows
    writeScript(api.db, id, 1, readScript(api.db, id, 1));
    expect((await count(api, id)).lines).toBe(1);
    expect(await keep(api, id, { chapters: [] })).toBe(0);

    // another effect: both are old again
    wear(api, id, createEffect(api.db, "louder", { name: "Louder", chain: louder }).id);
    expect((await count(api, id)).lines).toBe(2);

    // kept against no effect, which is not the same as not kept
    for (const s of maras(api, id))
      setClip(api, s.audio.url!, { sound: "0ld50und", raw: "/api/audio/x/raw.wav" });
    wear(api, id, null);
    expect(await keep(api, id, { speaker: "Mara" })).toBe(2);
    expect((await count(api, id)).lines).toBe(0);
    wear(api, id, e.id);
    expect((await count(api, id)).lines).toBe(2);
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
    expect(await count(api, id)).toEqual({ lines: 0, unavailable: 0 });

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

describe("re-applying some of the book", () => {
  test("redoes only the chapters asked for, and remembers them", async () => {
    const { api, id, fake } = await book();
    wear(api, id, createEffect(api.db, "echo", { name: "Echo", chain: echo }).id);
    const job = await reapply(api, id, { chapters: [2], speaker: "Mara" });
    expect(job.effectsRun).toEqual({ chapters: [2], speaker: "Mara" });
    expect(fake.calls.batch[0]).toHaveLength(1);
    expect((await stale(api, id)).chapters).toEqual([both[0]]);
  });

  test("of no chapters is refused", async () => {
    const { api, id } = await book();
    const { status } = await api.request(
      `/api/books/${id}/effects/reapply`,
      jsonBody({ chapters: [] }),
    );
    expect(status).toBe(400);
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
