// Two libraries in one server: the real one under `/api`, the demo under `/demo/api`.
//
// Each is built by the same `openLibrary` the server boots with, over a private database and
// folders of its own, and the two are reached through the same `serveLibraries` the listener
// uses — so what is proved here is the routing a browser meets. What the demo makes stays in the
// demo: its books, its clips and covers, whose urls only the demo answers; and its reset empties
// it and seeds it again without the real library noticing. Both libraries are handed providers
// whose `fetch` fails the test, so the demo's endpoints are shown to need no network. What the
// seed holds — the browser's whole demo world — is `demoWorld.test.ts`'s to check; the runs here
// are on a small book of the test's own, so they are quick.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Book, Character, Endpoint, ExportSettings, Job, Profile, Segment } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { isSimulated, SIMULATED_BASE_URL } from "@/lib/providers";
import { makeWorld } from "@/mock/world";
import type { Db } from "~/db/client";
import { SIMULATED_ID } from "~/demo/seed";
import { DEMO_BASE, openLibrary, REAL_BASE, serveLibraries, type Library } from "~/libraries";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { wavEncoders } from "~/providers/wavEncoder";
import { epubFile, story } from "../support/epub";
import { PNG } from "../support/images";
import {
  collectingLogger,
  jsonBody,
  tempAudioDir,
  tempExportDir,
  tempVoiceDir,
} from "../support/server";

/** A `fetch` that fails the test, and remembers where it was asked to go. */
function noNetwork() {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(String(url));
    throw new Error(`a library made a request: ${String(url)}`);
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}

interface Opened extends Library {
  audioDir: string;
  exportDir: string;
  voiceDir: string;
}

function open(
  name: string,
  base: string,
  fetch: typeof globalThis.fetch,
  { demo = false, databaseUrl = ":memory:" } = {},
): Opened {
  const dirs = { audioDir: tempAudioDir(), exportDir: tempExportDir(), voiceDir: tempVoiceDir() };
  const library = openLibrary({
    name,
    base,
    databaseUrl,
    ...dirs,
    encoders: wavEncoders(),
    log: collectingLogger().log,
    providers: {
      scripting: endpointScriptingProvider({ fetch }),
      speech: endpointSpeechProvider({ fetch }),
    },
    demo,
    // the demo's startup runs would hold the queue for most of a minute (`demoSpeed.test.ts`)
    still: true,
  });
  return Object.assign(library, dirs);
}

/** The server's two libraries, behind the one `fetch` the listener is given. */
function server() {
  const net = noNetwork();
  const real = open("real", REAL_BASE, net.fetch);
  const demo = open("demo", DEMO_BASE, net.fetch, { demo: true });
  const serve = serveLibraries(real, demo);
  const fetch = (path: string, init?: RequestInit) =>
    Promise.resolve(serve(new Request(`http://api.test${path}`, init)));
  const request = async <T = unknown>(path: string, init?: RequestInit) => {
    const res = await fetch(path, init);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const importTo = async (base: string, title: string, chapters = 1) => {
    const form = new FormData();
    const paragraphs = story(2);
    form.set(
      "file",
      await epubFile({
        title,
        chapters: Array.from({ length: chapters }, (_, i) => ({ title: `${i + 1}`, paragraphs })),
      }),
    );
    const { status, body } = await request<{ book: Book }>(`${base}/books/import`, {
      method: "POST",
      body: form,
    });
    expect(status).toBe(201);
    await request(`${base}/books/${body.book.id}/confirm`, { method: "POST" });
    return body.book;
  };
  const shelf = async (base: string) =>
    (await request<{ books: Book[] }>(`${base}/books`)).body.books.map((b) => b.title);
  const jobIds = async (base: string) =>
    (await request<{ jobs: Job[] }>(`${base}/jobs`)).body.jobs.map((j) => j.id);
  return { net, real, demo, fetch, request, importTo, shelf, jobIds };
}

type Server = ReturnType<typeof server>;

/** How many rows every table holds, the migrations' own record aside. */
function rowCounts(db: Db): Record<string, number> {
  const tables = db.$client
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.$client.query(`SELECT count(*) AS n FROM \`${name}\``).get() as { n: number }).n,
    ]),
  );
}

/** Every file under a directory, however deep; none when it is not there at all. */
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
    : [];

/** The seeded world's books, as the demo's shelf lists them. */
const SEEDED_TITLES = makeWorld().books.map((b) => b.title);

/** Script chapters of a book, and give every speaker the Simulated endpoint's voice. */
async function scriptAndCast(s: Server, bookId: string, ids: number[]): Promise<void> {
  await s.request(
    `${DEMO_BASE}/books/${bookId}/chapters/script`,
    jsonBody({ ids, profile: SIMULATED_ID }),
  );
  await s.demo.runner.idle();
  const cast = await s.request<{ characters: Character[] }>(`${DEMO_BASE}/books/${bookId}/cast`);
  for (const c of cast.body.characters)
    await s.request(`${DEMO_BASE}/books/${bookId}/characters/${encodeURIComponent(c.name)}`, {
      ...jsonBody({ ...c, voice: `${SIMULATED_ID}/ash` }),
      method: "PUT",
    });
}

/** Import a short book into the demo, script its first chapter, and narrate it. */
async function narrateOwn(s: Server): Promise<{ bookId: string; segments: Segment[] }> {
  const bookId = (await s.importTo(DEMO_BASE, "A Book of the Test's Own")).id;
  await scriptAndCast(s, bookId, [1]);
  const queued = await s.request<{ jobs: Job[] }>(
    `${DEMO_BASE}/books/${bookId}/chapters/narrate`,
    jsonBody({ ids: [1] }),
  );
  await s.demo.runner.idle();
  const job = await s.request<{ job: Job }>(`${DEMO_BASE}/jobs/${queued.body.jobs[0].id}`);
  expect(job.body.job.status).toBe("done");
  const script = await s.request<{ segments: Segment[] }>(
    `${DEMO_BASE}/books/${bookId}/chapters/1/script`,
  );
  return { bookId, segments: script.body.segments };
}

describe("the server's two libraries", () => {
  test("a path under /demo/api goes to the demo, and every other path to the real library", async () => {
    const s = server();
    expect(await s.shelf(DEMO_BASE)).toEqual(SEEDED_TITLES);
    expect(await s.shelf(REAL_BASE)).toEqual([]);
    expect((await s.request(`${DEMO_BASE}/health`)).body).toEqual({ ok: true });

    // each library's own 404 names the path it was asked for
    const missing = await s.request<{ error: { message: string } }>(`${DEMO_BASE}/nothing`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe(`No route for GET ${DEMO_BASE}/nothing`);
    // a path that only starts like the demo's is the real library's to refuse
    expect((await s.request("/demo/apis/books")).status).toBe(404);
    expect((await s.request("/api/demo/api/books")).status).toBe(404);
  });

  test("a fresh demo is seeded with the world and the Simulated preset, every endpoint simulated, and a fresh real library with nothing", async () => {
    const s = server();
    const demo = await s.request<{ endpoints: Endpoint[]; profiles: Profile[] }>(
      `${DEMO_BASE}/endpoints`,
    );
    for (const list of [demo.body.endpoints, demo.body.profiles]) {
      expect(list.map((e) => e.id)).toContain(SIMULATED_ID);
      expect(list.filter((e) => !isSimulated(e.baseUrl))).toEqual([]);
      const preset = list.find((e) => e.id === SIMULATED_ID)!;
      expect([preset.name, preset.baseUrl, preset.enabled]).toEqual([
        "Simulated (free)",
        SIMULATED_BASE_URL,
        true,
      ]);
    }
    const books = (await s.request<{ books: Book[] }>(`${DEMO_BASE}/books`)).body.books;
    expect(books.map((b) => b.title)).toEqual(SEEDED_TITLES);
    expect(books.every((b) => !b.importing && b.chapters!.total > 0)).toBe(true);

    const real = await s.request<{ endpoints: Endpoint[]; profiles: Profile[] }>(
      `${REAL_BASE}/endpoints`,
    );
    expect(real.body.endpoints).toEqual([]);
    expect(real.body.profiles).toEqual([]);
  });

  test("a demo that is not fresh is left as it is when it is opened again", async () => {
    const net = noNetwork();
    const databaseUrl = join(mkdtempSync(join(tmpdir(), "audiobook-demo-")), "demo.db");
    const first = open("demo", DEMO_BASE, net.fetch, { demo: true, databaseUrl });
    const listed = await first.app.request(`http://api.test${DEMO_BASE}/books`);
    const { books } = (await listed.json()) as { books: Book[] };
    await first.app.request(`http://api.test${DEMO_BASE}/books/${books[0].id}`, {
      method: "DELETE",
    });
    const left = rowCounts(first.db);
    first.db.$client.close();

    const again = open("demo", DEMO_BASE, net.fetch, { demo: true, databaseUrl });
    expect(rowCounts(again.db)).toEqual(left);
    expect(left.books).toBe(books.length - 1);
  });

  test("a book imported into one library is not on the other's shelf", async () => {
    const s = server();
    await s.importTo(DEMO_BASE, "Only in the demo");
    await s.importTo(REAL_BASE, "Only in the library");
    expect(await s.shelf(DEMO_BASE)).toEqual([...SEEDED_TITLES, "Only in the demo"]);
    expect(await s.shelf(REAL_BASE)).toEqual(["Only in the library"]);
  });

  test("the demo scripts and narrates with no network, and its clips are the demo's to serve", async () => {
    const s = server();
    const { bookId, segments } = await narrateOwn(s);
    expect(segments.length).toBeGreaterThan(2);
    for (const seg of segments) {
      expect(seg.audio.status).toBe("done");
      const url = seg.audio.url!;
      expect(url.startsWith(`${DEMO_BASE}/audio/${bookId}/`)).toBe(true);
      const served = await s.fetch(url);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("audio/wav");
      // the real library has no route for it, and no file under its own
      expect((await s.real.app.request(`http://api.test${url}`)).status).toBe(404);
      expect((await s.fetch(url.slice("/demo".length))).status).toBe(404);
    }
    expect(filesUnder(s.demo.audioDir).length).toBe(segments.length);
    expect(filesUnder(s.real.audioDir)).toEqual([]);
    expect(s.net.asked).toEqual([]);
  }, 20_000);

  test("a cover uploaded in the demo is under the demo's base, and a build there names no other", async () => {
    const s = server();
    const bookId = (await s.request<{ books: Book[] }>(`${DEMO_BASE}/books`)).body.books[0].id;
    const form = new FormData();
    form.set("file", new File([PNG], "cover.png"));
    const { status, body } = await s.request<{ cover: string }>(
      `${DEMO_BASE}/books/${bookId}/covers`,
      { method: "POST", body: form },
    );
    expect(status).toBe(201);
    expect(body.cover).toMatch(
      new RegExp(`^${DEMO_BASE}/books/${bookId}/covers/[a-f0-9]{32}\\.png$`),
    );
    expect((await s.fetch(body.cover)).status).toBe(200);
    expect((await s.fetch(body.cover.slice("/demo".length))).status).toBe(404);

    const REFUSED = "The cover image is not one this server holds; choose it again";
    const build = (cover: string) =>
      s.request<{ error?: { message: string } }>(
        `${DEMO_BASE}/books/${bookId}/exports`,
        jsonBody({ ids: [1], settings: { ...DEFAULT_EXPORT_SETTINGS, cover } as ExportSettings }),
      );
    expect((await build(body.cover.slice("/demo".length))).body.error?.message).toBe(REFUSED);
    expect((await build(body.cover)).body.error?.message).not.toBe(REFUSED);
  });

  test("an EPUB's cover imported into the demo is kept under the demo's base", async () => {
    const s = server();
    const form = new FormData();
    form.set(
      "file",
      await epubFile({ chapters: [{ title: "One", paragraphs: story(1) }], cover: { bytes: PNG } }),
    );
    const { body } = await s.request<{ book: Book }>(`${DEMO_BASE}/books/import`, {
      method: "POST",
      body: form,
    });
    expect(body.book.coverImage).toMatch(new RegExp(`^${DEMO_BASE}/books/${body.book.id}/covers/`));
    expect((await s.fetch(body.book.coverImage!)).status).toBe(200);
  });
});

describe("resetting the demo", () => {
  test("empties it — books, jobs, clips on disk — and seeds it again, leaving the real library as it was", async () => {
    const s = server();
    // started as the server starts it, so what the first seed set going is in the count too
    await s.demo.start();
    const fresh = rowCounts(s.demo.db);
    const history = await s.jobIds(DEMO_BASE);
    await narrateOwn(s);
    await s.importTo(DEMO_BASE, "Only in the demo");
    await s.importTo(REAL_BASE, "Only in the library");
    const real = rowCounts(s.real.db);
    expect(filesUnder(s.demo.audioDir).length).toBeGreaterThan(0);

    const reset = await s.request<{ seeded: unknown }>(`${DEMO_BASE}/demo/reset`, {
      method: "POST",
    });
    expect(reset.status).toBe(200);
    const world = makeWorld();
    expect(reset.body.seeded).toEqual({
      endpoints: [...world.endpoints.map((e) => e.id), SIMULATED_ID],
      profiles: [...world.profiles.map((p) => p.id), SIMULATED_ID],
      books: world.books.map((b) => b.id),
    });

    // row for row what a fresh demo holds, the queue's history as it began, and not a file left
    // from before
    expect(rowCounts(s.demo.db)).toEqual(fresh);
    expect(await s.shelf(DEMO_BASE)).toEqual(SEEDED_TITLES);
    expect(await s.jobIds(DEMO_BASE)).toEqual(history);
    expect(filesUnder(s.demo.audioDir)).toEqual([]);

    expect(rowCounts(s.real.db)).toEqual(real);
    expect(await s.shelf(REAL_BASE)).toEqual(["Only in the library"]);

    // and the demo's queue runs again afterwards
    await narrateOwn(s);
    expect(s.net.asked).toEqual([]);
  }, 20_000);

  test("abandons the job it finds running, so nothing from before lands after", async () => {
    const s = server();
    const history = await s.jobIds(DEMO_BASE);
    const bookId = (await s.importTo(DEMO_BASE, "Two Chapters", 2)).id;
    await scriptAndCast(s, bookId, [1, 2]);
    // the Simulated endpoint takes most of a second a line, so the first job is still running
    await s.request(`${DEMO_BASE}/books/${bookId}/chapters/narrate`, jsonBody({ ids: [1, 2] }));
    expect(s.demo.runner.running?.kind).toBe("narration");

    expect((await s.request(`${DEMO_BASE}/demo/reset`, { method: "POST" })).status).toBe(200);
    await s.demo.runner.idle();
    expect(await s.jobIds(DEMO_BASE)).toEqual(history);
    expect(filesUnder(s.demo.audioDir)).toEqual([]);
    expect((await s.request(`${DEMO_BASE}/books/${bookId}`)).status).toBe(404);
  });

  test("is the demo's alone: the real library has neither route", async () => {
    const s = server();
    await s.importTo(REAL_BASE, "Only in the library");
    const refused = await s.request(`${REAL_BASE}/demo/reset`, { method: "POST" });
    expect(refused.status).toBe(404);
    const situation = await s.request(`${REAL_BASE}/demo/situations/fresh-book`, {
      method: "POST",
    });
    expect(situation.status).toBe(404);
    expect(await s.shelf(REAL_BASE)).toEqual(["Only in the library"]);
  });
});
