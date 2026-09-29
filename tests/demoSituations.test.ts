// Does a Demo tools situation leave the server's demo as it leaves the browser's?
//
// The browser applies a situation through its stores (`useDemoStore()._scenarioContext()`); the
// server applies the same situation through a context over plain data (`server/demo/situations.ts`)
// and writes the result as the demo's seed. So the browser is the oracle: both run in this process
// on a clock stopped at one instant, the browser's stores go back to the seeded world and have the
// situation applied, the server's demo is put into it through `POST /demo/situations/:id`, and
// everything the server answers over its API is compared with what the stores hold — books (the
// imports in review and the shelf's too) and their chapters, the prose of every book the situation
// added, casts and dictionaries, every script line with its clips, flags, retakes and candidates,
// chapters' script histories, the queue, the exports, what each book has spent, and every endpoint
// and profile's settings. What `startLive` is handed — the runs, the builds, the telemetry — is
// compared too, with what the browser's endpoints and scripting profiles hold.
//
// It sits beside the browser's tests rather than under `tests/server/` because it runs the stores:
// the server's type-check project holds the server and the pure half of `src/`, never the stores
// and the services they reach for.
//
// What is deliberately not compared, and why:
//   - what `startLive` makes of what it is handed — runs in flight, builds, ledger rows and
//     cooldowns: the live half's own tests hold it to that. Here it is a stub that keeps what it is
//     given, so the rows compared are exactly the situation's and nothing is running under them;
//   - the builds the browser would start for `builds`: its `seedBuilds` is replaced by the same
//     "note the book" the server does, and the two notes are compared;
//   - everything `demoWorld.test.ts` already leaves out of the seeded world, for the same reasons:
//     endpoint telemetry on the endpoint (compared here as `startLive`'s instead), a moved
//     `baseUrl` and `needsKey`, a clip's file `url` and `sampleRate`, the shelf's `chapters`
//     counts, an export's `createdAt` past the day;
//   - a book's `sample`, which only the browser keeps — the server composes the prose from it as it
//     writes, and the prose is compared instead; and "just now" as an import's `addedAt`, which the
//     server keeps as the day it was seeded;
//   - the order of the shelf, which the browser keeps as books were added and the server by the day
//     each was added: compared as a set;
//   - the id of an export a situation adds, which the browser draws at random and the server numbers
//     after the world's own;
//   - a chapter's script history outside the situation's own book, where the browser holds none:
//     every chapter of the situation's book is read, and every chapter the browser has one for.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { toRaw } from "vue";

import { DEMO_GROUPS, demoScenarios } from "@/mock/scenarios/catalogue";
import { applySituation } from "@/mock/scenarios/situations";
import { makeWorld } from "@/mock/world";
import { chapterParts, partsText } from "@/mock/world/text";
import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import type {
  Book,
  BookSpend,
  Chapter,
  ChapterHistory,
  Character,
  DemoResult,
  DemoScenario,
  Endpoint,
  ExportItem,
  Job,
  LexEntry,
  Profile,
  ScriptEndpointTelemetry,
  Segment,
  SegmentAudio,
  Take,
} from "@/types";
import { createApp } from "~/app";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import type { DemoLive } from "~/demo/live";
import { demoReset } from "~/demo/reset";
import { createRunner, type Runner } from "~/jobs/runner";
import { DEMO_BASE, openLibrary } from "~/libraries";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { createSpeechGate } from "~/providers/gate";
import { wavEncoders } from "~/providers/wavEncoder";
import { voiceFiles } from "~/voices/files";
import { testPinia } from "./support/pinia";
import { collectingLogger, tempAudioDir, tempExportDir, tempVoiceDir } from "./support/server";

/** The instant both demos are seeded at, and every situation applied at. */
const NOW = Date.parse("2026-09-29T12:00:00Z");
const TODAY = new Date(NOW).toISOString().slice(0, 10);

const SITUATIONS = demoScenarios();

/** The world as it is seeded, for telling what a situation added from what it was given. */
const PRISTINE = makeWorld(NOW);
const PRISTINE_BOOKS = new Set(PRISTINE.books.map((b) => b.id));
const PRISTINE_EXPORTS = new Set(PRISTINE.exports.map((e) => e.id));

/** A `fetch` that fails the test: nothing the demo holds may reach the network. */
const noNetwork = (async (url: string) => {
  throw new Error(`the demo made a request: ${String(url)}`);
}) as unknown as typeof globalThis.fetch;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(toRaw(x))) as T;

// ---------- the browser's demo ----------

/** What the browser's stores hold once a situation is applied, read past their proxies. */
interface BrowserState {
  result: DemoResult;
  builds: string[];
  books: Book[];
  chapters: Record<string, Chapter[]>;
  characters: Record<string, Character[]>;
  lexicon: Record<string, LexEntry[]>;
  segments: Record<string, Segment[]>;
  histories: Record<string, ChapterHistory>;
  jobs: Job[];
  exports: ExportItem[];
  endpoints: Endpoint[];
  profiles: Profile[];
  scripting: Record<string, ScriptEndpointTelemetry>;
  spend: Record<string, { spent: number; scriptSpent: number }>;
}

function applyInBrowser(s: DemoScenario): BrowserState {
  const demoStore = useDemoStore();
  const library = useLibraryStore();
  const cast = useCastStore();
  const jobs = useJobsStore();
  const usage = useUsageStore();
  demoStore._restoreWorld();
  const builds: string[] = [];
  const ctx = { ...demoStore._scenarioContext(), seedBuilds: (id: string) => void builds.push(id) };
  const result = applySituation(ctx, s.id, s.bookId);
  return {
    result,
    builds,
    books: clone(library.books),
    chapters: clone(library.chapters),
    characters: clone(cast.characters),
    lexicon: clone(cast.lexicon),
    segments: clone(useScriptsStore().segments),
    histories: clone(useHistoryStore().chapters),
    jobs: clone(jobs.jobs),
    exports: clone(useExportsStore().exports),
    endpoints: clone(useEndpointsStore().endpoints),
    profiles: clone(useEndpointsStore().profiles),
    scripting: clone(jobs.scriptTelemetry),
    spend: Object.fromEntries(
      library.books.map((b) => [
        b.id,
        { spent: jobs.spent(b.id), scriptSpent: usage.scriptSpent(b.id) },
      ]),
    ),
  };
}

// ---------- the server's demo ----------

let db: Db;
let runner: Runner;
let app: ReturnType<typeof createApp>;
/** what the last situation handed `startLive` */
let handed: DemoLive | null = null;

beforeAll(() => {
  setSystemTime(new Date(NOW));
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  testPinia();
  useUiStore().toast = () => "test";

  const { log } = collectingLogger();
  db = openDb(":memory:");
  migrate(db);
  runner = createRunner(db, {}, { log });
  const gate = createSpeechGate();
  const files = voiceFiles(tempVoiceDir());
  const reset = demoReset({
    db,
    runner,
    gate,
    voiceFiles: files,
    base: DEMO_BASE,
    dirs: [tempAudioDir(), tempExportDir()],
    live: async (live) => {
      handed = live;
    },
  });
  app = createApp(db, { base: DEMO_BASE, log, runner, gate, voiceFiles: files, reset });
});

afterAll(async () => {
  await runner.stop();
  db.$client.close();
  setSystemTime();
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await app.request(`http://api.test${DEMO_BASE}${path}`, init);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

// ---------- the comparison ----------

const withoutFiles = (s: Segment): Segment => {
  const stripped = <T extends SegmentAudio | Take>({ url: _u, sampleRate: _r, ...clip }: T) => clip;
  return {
    ...s,
    audio: {
      ...stripped(s.audio),
      ...(s.audio.takes ? { takes: s.audio.takes.map(stripped) } : {}),
    },
    ...(s.candidate ? { candidate: stripped(s.candidate) } : {}),
  };
};

const settingsOf = ({
  history: _h,
  failures: _f,
  rateLimits: _r,
  backoffUntil: _b,
  lastError: _l,
  baseUrl: _u,
  needsKey: _k,
  hasKey: _hk,
  expressions,
  credentialId,
  ...rest
}: Endpoint & { hasKey?: boolean }) => ({
  ...rest,
  ...(credentialId != null ? { credentialId } : {}),
  ...(expressions ? { expressions: { ...expressions, baseUrl: "" } } : {}),
});

const profileOf = ({
  baseUrl: _u,
  needsKey: _k,
  hasKey: _hk,
  ...rest
}: Profile & { hasKey?: boolean }) => rest;

const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

/** An export as both sides can agree on it: its day, and an added one's id left out. */
const comparableExport = (e: ExportItem) => ({
  ...e,
  id: PRISTINE_EXPORTS.has(e.id) ? e.id : "added",
  createdAt: e.createdAt.slice(0, 10),
});
const exportOrder = (
  a: ReturnType<typeof comparableExport>,
  b: ReturnType<typeof comparableExport>,
) =>
  `${a.bookId}|${a.filename}|${a.version}`.localeCompare(`${b.bookId}|${b.filename}|${b.version}`);

const EMPTY_HISTORY: ChapterHistory = {
  versions: [],
  head: { at: 0, origin: { kind: "scripted" } },
  nextId: 1,
};

async function compare(s: DemoScenario, browser: BrowserState): Promise<void> {
  // the shelf: every book the browser holds, and no other
  const { books } = await request<{ books: Book[] }>("/books");
  expect(books.map(({ chapters: _counts, ...b }) => b).sort(byId)).toEqual(
    browser.books
      .map(({ sample: _sample, ...b }) => ({
        ...b,
        addedAt: b.addedAt === "just now" ? TODAY : b.addedAt,
      }))
      .sort(byId),
  );

  for (const book of browser.books) {
    const chs = browser.chapters[book.id] ?? [];
    const { chapters } = await request<{ chapters: Chapter[] }>(`/books/${book.id}`);
    expect(chapters).toEqual(chs);

    const cast = await request<{ characters: Character[]; lexicon: LexEntry[] }>(
      `/books/${book.id}/cast`,
    );
    expect(cast.characters).toEqual(browser.characters[book.id] ?? []);
    expect(cast.lexicon).toEqual(browser.lexicon[book.id] ?? []);

    // an added book's prose is composed from the sample the server does not keep
    if (!PRISTINE_BOOKS.has(book.id))
      for (const c of chs) {
        const { text } = await request<{ text: string }>(
          `/books/${book.id}/chapters/${c.id}/text?format=markdown`,
        );
        expect(text).toBe(partsText(chapterParts(book.id, c.id, c, book.sample)));
      }

    for (const c of chs) {
      const key = `${book.id}:${c.id}`;
      const { segments } = await request<{ segments: Segment[] }>(
        `/books/${book.id}/chapters/${c.id}/script`,
      );
      expect(segments.map(withoutFiles)).toEqual(browser.segments[key] ?? []);
      if (book.id !== s.bookId && !browser.histories[key]) continue;
      const { history } = await request<{ history: ChapterHistory }>(
        `/books/${book.id}/chapters/${c.id}/history`,
      );
      expect(history).toEqual(browser.histories[key] ?? EMPTY_HISTORY);
    }

    const { exports } = await request<{ exports: ExportItem[] }>(`/books/${book.id}/exports`);
    expect(exports.map(comparableExport).sort(exportOrder)).toEqual(
      browser.exports
        .filter((e) => e.bookId === book.id)
        .map(comparableExport)
        .sort(exportOrder),
    );

    const { spend } = await request<{ spend: BookSpend }>(`/books/${book.id}/spend`);
    expect(spend.spent).toBeCloseTo(browser.spend[book.id].spent, 9);
    expect(spend.scriptSpent).toBeCloseTo(browser.spend[book.id].scriptSpent, 9);
  }

  const { jobs } = await request<{ jobs: Job[] }>("/jobs");
  expect(jobs).toEqual(browser.jobs);

  const config = await request<{ endpoints: Endpoint[]; profiles: Profile[] }>("/endpoints");
  expect(config.endpoints.slice(0, -1).map(settingsOf)).toEqual(browser.endpoints.map(settingsOf));
  expect(config.profiles.slice(0, -1).map(profileOf)).toEqual(browser.profiles.map(profileOf));

  // what is left for `startLive`, and what the browser's endpoints and profiles have been through
  expect(handed).toEqual({
    bookId: s.bookId,
    runs: s.runs ?? [],
    builds: browser.builds,
    speech: Object.fromEntries(
      browser.endpoints.map(({ id, history, failures, rateLimits, backoffUntil, lastError }) => [
        id,
        { history, failures, rateLimits, backoffUntil, ...(lastError ? { lastError } : {}) },
      ]),
    ),
    scripting: browser.scripting,
  });
}

describe("a situation applied on the server leaves the demo as the browser's demo leaves it", () => {
  for (const s of SITUATIONS)
    test(s.id, async () => {
      const browser = applyInBrowser(s);
      const answer = await request<{
        scenario: Pick<DemoScenario, "id" | "name" | "bookId" | "path" | "steps">;
        note: string;
        open: string;
      }>(`/demo/situations/${s.id}`, { method: "POST" });
      expect(answer).toEqual({
        scenario: { id: s.id, name: s.name, bookId: s.bookId, path: s.path, steps: s.steps ?? [] },
        note: browser.result.note,
        open: browser.result.open ?? s.path,
      });
      await compare(s, browser);
    });
});

describe("the situations' routes", () => {
  test("list every situation the Demo tools offer, with the headings they go under", async () => {
    const listed = await request<{
      groups: typeof DEMO_GROUPS;
      situations: Omit<DemoScenario, "runs">[];
    }>("/demo/situations");
    expect(listed.groups).toEqual(DEMO_GROUPS);
    expect(listed.situations).toEqual(
      SITUATIONS.map(({ id, group, name, blurb, bookId, path, steps }) => ({
        id,
        group,
        name,
        blurb,
        bookId,
        path,
        steps,
      })),
    );
  });

  test("refuse a situation there is no such row for, and leave the demo as it was", async () => {
    const before = await request<{ books: Book[] }>("/books");
    const res = await app.request(`http://api.test${DEMO_BASE}/demo/situations/nothing-like-it`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(await request<{ books: Book[] }>("/books")).toEqual(before);
  });

  test("put the demo library into a situation, its own `startLive` and all, with no network", async () => {
    const demo = openLibrary({
      name: "demo",
      base: DEMO_BASE,
      databaseUrl: ":memory:",
      audioDir: tempAudioDir(),
      exportDir: tempExportDir(),
      voiceDir: tempVoiceDir(),
      encoders: wavEncoders(),
      log: collectingLogger().log,
      providers: {
        scripting: endpointScriptingProvider({ fetch: noNetwork }),
        speech: endpointSpeechProvider({ fetch: noNetwork }),
      },
      demo: true,
    });
    await demo.start();
    const res = await demo.app.request(`http://api.test${DEMO_BASE}/demo/situations/import-clean`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { open: string }).open).toBe("/book/import-clean/contents");
    const listed = await demo.app.request(`http://api.test${DEMO_BASE}/books`);
    const { books } = (await listed.json()) as { books: Book[] };
    expect(books.find((b) => b.id === "import-clean")?.importing).toBe(true);
    await demo.runner.stop();
    demo.db.$client.close();
  });
});
