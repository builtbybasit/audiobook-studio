// The jobs, scripting, narration, scripts, cast, history and exports stores against the real API.
//
// `libraryBackend.test.ts` next door proves the library store's backend half. This is the rest:
// the stores the Queue, Scripting and Cast pages read, driven through the real `HttpJobsService`
// and `HttpLibraryService` against the real Hono app, the real runner and a fake scripting model,
// over a private in-memory database. The pages read through the query composables in
// `src/queries/`, so the tests do too: the queue is read the way the shell reads it, and a
// chapter's script, history and cast the way the Scripting and Cast pages open them.
//
// What these guard is that what the screens show is what the server holds, not what the store
// assumed when it sent the request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { BookSpend, Endpoint, RequestRecord, Segment } from "@/types";
import { makeCredentials } from "~/demo/seed/fixtures/credentials";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { key } from "@/lib/scriptReview";
import { clone } from "@/lib/utils";
import { silenceOf } from "@/lib/speech";
import {
  useBookExports,
  useBookJobs,
  useCast,
  useChapterHistory,
  useBookSpend,
  useChapterScript,
  useEndpointHistory,
  useEndpointLive,
  invalidate,
  keys,
} from "@/queries";
import type { EndpointDescriptor } from "@/services/endpoints";
import {
  HttpEndpointSettingsService,
  setEndpointSettingsService,
} from "@/services/endpointSettings";
import { fetchCast } from "@/queries/cast";
import { HttpJobsService, setJobsService } from "@/services/jobs";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useTransferStore } from "@/stores/transfer";
import { useUiStore } from "@/stores/ui";
import { readScript, scriptRevision, writeScript } from "~/db/script";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import { pointServicesAt, type ServiceWiring } from "./support/backendServer";
import { epubFile, story } from "./support/epub";
import { flush, testPinia, type TestPinia } from "./support/pinia";
import { openaiProfile } from "./support/profiles";
import { unifyEndpoint } from "@/lib/endpoints";
import { useEndpointActivity } from "@/views/endpoints/live";
import { useNarrationData } from "@/views/narration/useNarrationData";
import { useScriptActivity } from "@/queries/scriptActivity";
import { scriptTelemetry, scriptUsageTotals } from "@/lib/scriptActivity";
import {
  gatedProvider,
  gatedSpeechProvider,
  jsonBody,
  testApi,
  type TestApi,
} from "./support/server";

let api: TestApi;
let pinia: TestPinia;
let castStore: ReturnType<typeof useCastStore>;
let historyStore: ReturnType<typeof useHistoryStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let queue: ReturnType<typeof useBookJobs>;
let toasts: { msg: string; kind?: string; undo?: (() => unknown) | null }[];
/** every path a store asked the server for, in order */
let asked: string[];
/** every request's body, by path, for the tests that check what a write said */
let sent: { path: string; body: unknown }[];
/** Holds a response on its way back to the store, so something else can land in between. */
let hold: ((path: string, init?: RequestInit) => Promise<void>) | null;

const volume = (titles: string[]) =>
  epubFile({
    chapters: titles.map((title) => ({
      title,
      paragraphs: [
        "“We are short again,” said Mara.",
        "“Then we count it twice,” said Tobin.",
        // a few lines past the dialogue, and no more: the dialogue already keeps the chapter from
        // reading as a notice, and every line here is one more clip each narration test renders
        ...story(4),
      ],
    })),
  });

/** Let a fire-and-forget store action's requests land and what they invalidate be read again. */
const settle = async () => {
  await flush();
  await flush();
  await flush();
};
/** The queue read again, as the shell's poll would, and everything a moved job brings with it. */
const poll = async () => {
  await queue.refetch();
  await settle();
};

/** Endpoints are left out unless asked for: most of these suites never load the endpoints store. */
function wire(options: Parameters<typeof testApi>[0] = {}, wiring: ServiceWiring = {}) {
  api = testApi(options);
  wireStores(wiring);
}

/** Fresh stores over the same server, as a reload would give. */
function wireStores({ endpoints = false }: ServiceWiring = {}) {
  // the ui store reaches for `matchMedia` as it is built, and Bun has no window
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  asked = [];
  sent = [];
  hold = null;
  const fetch: TestApi["fetch"] = async (input, init) => {
    asked.push(input);
    if (typeof init?.body === "string") sent.push({ path: input, body: JSON.parse(init.body) });
    const response = await api.fetch(input, init);
    if (hold) await hold(input, init);
    return response;
  };
  // The services go in before the stores are created: a store reads its service while building
  // its state.
  pointServicesAt(fetch, { endpoints });
  pinia?.stop();
  pinia = testPinia();
  castStore = useCastStore();
  historyStore = useHistoryStore();
  libraryStore = useLibraryStore();
  jobsStore = useJobsStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  // the shell reads the queue for as long as the app is open
  queue = pinia.run(() => useBookJobs());
  toasts = [];
  const uiStore = useUiStore();
  uiStore.toast = (msg, opts = {}) => {
    toasts.push({ msg, kind: opts.kind, undo: opts.undo ?? null });
    return "";
  };
}

/** A shelved book with three chapters, through the store. */
async function shelved(titles = ["One", "Two", "Three"]): Promise<string> {
  const id = (await libraryStore.importBook({ source: await volume(titles) }))!;
  await libraryStore.confirmImport(id);
  return id;
}

/** Chapter 1 scripted by the server, with its script, history and cast open the way the pages open them. */
async function scriptedAndOpen() {
  const id = await shelved();
  const script = pinia.run(() => useChapterScript(id, 1));
  const history = pinia.run(() => useChapterHistory(id, 1));
  const cast = pinia.run(() => useCast(id));
  await settle();
  await scriptingStore.runScripting(id, [1], { quiet: true });
  await api.runner.idle();
  await poll();
  return { id, script, history, cast };
}

/** Chapter 1 scripted and then narrated on the server, as the Narration page would find it. */
async function narrated() {
  const opened = await scriptedAndOpen();
  const narrationStore = useNarrationStore();
  await narrationStore.runNarration(opened.id, [1], { quiet: true });
  await api.runner.idle();
  await poll();
  return { ...opened, narrationStore };
}

/**
 * Every speaker of the book cast with a voice on `studio`, and the stores reading both — what a
 * run button asks before it lets a run start (`narration.startRun`).
 */
async function voiced(id: string) {
  await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [studio], profiles: [], credentials: [] }),
    method: "PUT",
  });
  for (const c of castStore.charactersOf(id))
    await api.request(`/api/books/${id}/characters/${encodeURIComponent(c.name)}`, {
      ...jsonBody({ ...c, voice: "studio/ash" }),
      method: "PUT",
    });
  setEndpointSettingsService(new HttpEndpointSettingsService("/api", api.fetch));
  await useEndpointsStore().load(true);
  await fetchCast(id);
}

/** A chapter 1 another tab wrote underneath this one. */
const writtenElsewhere = (): Segment[] => [
  {
    id: 1,
    type: "narration",
    speaker: "Narrator",
    text: "Written elsewhere.",
    direction: "",
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  },
];

/** A speech endpoint of the server's own, for the tests that need clips to name one. */
const studio: Endpoint = {
  id: "studio",
  name: "Studio speech",
  baseUrl: "http://localhost:8880/v1",
  model: "studio-tts",
  concurrency: 1,
  enabled: true,
  latency: 0,
  failRate: 0,
  price: 15,
  needsKey: false,
  maxChars: 0,
  splitAt: "sentence",
  voices: [{ id: "ash", gender: "m", label: "Ash" }],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
};

beforeEach(() => wire());

// The services are module state, and every other suite in this repository talks to the demo.
afterEach(() => {
  pinia.stop();
  useEndpointsStore()._detach();
  pointServicesAt(null);
});

describe("the queue with a server answering", () => {
  test("a scripting run is queued on the server, and the chapters say so at once", async () => {
    const gate = gatedProvider();
    wire({ scripting: gate.provider });
    const id = await shelved();
    scriptingStore.runScripting(id, [1, 2]);
    await settle();
    // the toast, and the two jobs the server made, read back through the queue
    expect(toasts.at(-1)?.msg).toBe("Script · 2 chapters");
    expect(jobsStore.jobs.map((j) => [j.kind, j.chapterId])).toEqual([
      ["scripting", 1],
      ["scripting", 2],
    ]);
    expect(jobsStore.activeJobs).toHaveLength(2);
    expect(queue.active.value).toHaveLength(2);
    // the chapters were marked by the server's answer, not by the store ahead of it
    expect(libraryStore.chapter(id, 1)?.scripting).toBe("running");
    expect(libraryStore.chapter(id, 2)?.scripting).toBe("queued");
    gate.release();
    await api.runner.idle();
  });

  test("the script arrives in the store when the job lands, and the chapter reads as scripted", async () => {
    const { id, script } = await scriptedAndOpen();
    expect(jobsStore.jobs[0].status).toBe("done");
    expect(libraryStore.chapter(id, 1)?.scripting).toBe("done");
    const segs = scriptsStore.segmentsOf(id, 1);
    expect(segs.length).toBeGreaterThan(1);
    expect(script.segments.value).toBe(segs);
    // the fake model's attribution, read from the prose
    expect(segs.find((s) => s.type === "dialogue")?.speaker).toBe("Mara");
    expect(script.loaded.value).toBe(true);
    expect(scriptsStore._revision[key(id, 1)]).toBe(1);
    // a chapter nothing has scripted stays unscripted and unread
    expect(libraryStore.chapter(id, 2)?.scripting).toBe("none");
    expect(scriptsStore.segmentsOf(id, 2)).toEqual([]);
  });

  test("a finished run brings its speakers into the cast and its version into the history", async () => {
    const { id, cast, history } = await scriptedAndOpen();
    expect(cast.characters.value.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Narrator", "Mara", "Tobin"]),
    );
    expect(castStore.charactersOf(id).find((c) => c.name === "Mara")?.isNew).toBe(true);
    // the first script has nothing to preserve, so the history says how it came to be and holds no version
    expect(history.head.value.origin.kind).toBe("scripted");
    expect(history.versions.value).toEqual([]);
    // edited by hand, then scripted again: the run preserves the edited script before replacing it
    const line = scriptsStore.segmentsOf(id, 1)[0];
    scriptsStore.updateSegment(id, 1, line.id, { text: "By hand." });
    await scriptsStore._settled(id, 1);
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    expect(history.versions.value.map((v) => v.origin.kind)).toEqual(["edited", "scripted"]);
    expect(history.versions.value[0].segments[0].text).toBe("By hand.");
    expect(historyStore.headOf(id, 1).origin).toMatchObject({ kind: "scripted", again: true });
  });

  test("opening a scripted chapter reads its script once", async () => {
    const id = await shelved();
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    // a fresh store, as a reload would give: nothing until it is asked for
    wireStores();
    await libraryStore.loadBook(id);
    expect(scriptsStore.segmentsOf(id, 1)).toEqual([]);
    const path = `/api/books/${id}/chapters/1/script`;
    pinia.run(() => useChapterScript(id, 1));
    await settle();
    expect(scriptsStore.segmentsOf(id, 1).length).toBeGreaterThan(0);
    pinia.run(() => useChapterScript(id, 1));
    await settle();
    expect(asked.filter((p) => p === path)).toHaveLength(1);
  });

  test("the first read of the queue is history, not change: nothing is fetched on its account", async () => {
    const id = await shelved();
    await scriptingStore.runScripting(id, [1, 2], { quiet: true });
    await api.runner.idle();
    // a reload: fresh stores over the same server, counting what the queue's first read asks for
    wireStores();
    await settle();
    await libraryStore.loadBook(id);
    asked.length = 0;
    await poll();
    expect(jobsStore.jobs).toHaveLength(2);
    expect(asked).toEqual(["/api/jobs"]);
    // and the reader's own read of a script is not undone by a later poll seeing the same jobs
    pinia.run(() => useChapterScript(id, 1));
    await settle();
    await poll();
    expect(scriptsStore._previous[key(id, 1)]).toBeUndefined();
  });

  test("a re-script keeps the previous script for the diff", async () => {
    const { id } = await scriptedAndOpen();
    const first = scriptsStore.segmentsOf(id, 1);
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    expect(scriptsStore._previous[key(id, 1)]).toEqual(first);
    expect(scriptsStore._revision[key(id, 1)]).toBe(2);
  });

  test("chapters the server left out are said so, not waited for", async () => {
    const id = await shelved();
    await libraryStore.skipChapters(id, [2], true, { quiet: true });
    await scriptingStore.runScripting(id, [2]);
    expect(toasts.at(-1)?.msg).toBe("Nothing to script");
    expect(toasts.at(-1)?.kind).toBe("warn");
    expect(jobsStore.jobs).toEqual([]);
  });

  test("cancelling goes to the server, and the chapter follows", async () => {
    const gate = gatedProvider();
    wire({ scripting: gate.provider });
    const id = await shelved();
    await scriptingStore.runScripting(id, [1, 2], { quiet: true });
    await gate.started;
    await settle();
    expect(libraryStore.chapter(id, 2)?.scripting).toBe("queued");

    const waiting = jobsStore.jobs.find((j) => j.chapterId === 2)!;
    jobsStore.cancelJob(waiting.id);
    // the store does not mark anything itself; the server's answer is what changes it
    expect(jobsStore.jobs.find((j) => j.id === waiting.id)?.cancelled).toBe(false);
    await settle();
    expect(jobsStore.jobs.find((j) => j.id === waiting.id)?.status).toBe("cancelled");
    expect(libraryStore.chapter(id, 2)?.scripting).toBe("none");

    gate.release();
    await api.runner.idle();
  });

  test("run next goes to the server, and the queue reads the order it set", async () => {
    const gate = gatedProvider();
    wire({ scripting: gate.provider });
    const id = await shelved();
    await scriptingStore.runScripting(id, [1, 2, 3], { quiet: true });
    await gate.started;
    await settle();

    const last = jobsStore.jobs.find((j) => j.chapterId === 3)!;
    sent.length = 0;
    jobsStore.runNext([last.id]);
    await settle();
    expect(sent).toEqual([{ path: "/api/jobs/run-next", body: { ids: [last.id] } }]);
    expect(jobsStore.jobs.find((j) => j.id === last.id)?.priority).toBe(1);

    gate.release();
    await api.runner.idle();
  });

  test("clearing the history and removing a job go through the server", async () => {
    const id = await shelved();
    await scriptingStore.runScripting(id, [1, 2], { quiet: true });
    await api.runner.idle();
    await poll();
    expect(jobsStore.jobs).toHaveLength(2);
    jobsStore.removeJob(jobsStore.jobs[0].id);
    await settle();
    expect(jobsStore.jobs).toHaveLength(1);
    jobsStore.clearFinished();
    await settle();
    expect(jobsStore.jobs).toEqual([]);
  });

  test("a queue that cannot be read says so and keeps what it had", async () => {
    const id = await shelved();
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    const had = jobsStore.jobs.length;
    setJobsService(new HttpJobsService("/api", () => Promise.reject(new Error("ECONNREFUSED"))));
    await poll();
    expect(jobsStore.jobs).toHaveLength(had);
    expect(toasts.at(-1)?.msg).toBe("Could not reach the server");
  });
});

describe("editing a script with a server answering", () => {
  test("an edit is written back with the revision it read, and the history follows", async () => {
    const { id, history } = await scriptedAndOpen();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    scriptsStore.updateSegment(id, 1, line.id, { text: "Edited in the reader." });
    await scriptsStore._settled(id, 1);
    expect(scriptsStore._revision[key(id, 1)]).toBe(2);
    expect(readScript(api.db, id, 1)[0].text).toBe("Edited in the reader.");
    // the server preserved the model's script before the edit, and says the edit is in progress
    expect(history.versions.value.map((v) => v.origin.kind)).toEqual(["scripted"]);
    expect(history.head.value.origin).toEqual({ kind: "edited", edits: 1 });
    // nothing went wrong, and nothing was captured locally: the history is the server's
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
  });

  test("a burst of edits is written as they stand, not one write per keystroke", async () => {
    const { id } = await scriptedAndOpen();
    const [a, b] = scriptsStore.segmentsOf(id, 1);
    asked.length = 0;
    scriptsStore.updateSegment(id, 1, a.id, { text: "One." });
    scriptsStore.updateSegment(id, 1, b.id, { text: "Two." });
    scriptsStore.setSpeaker(id, 1, b.id, "Narrator");
    await scriptsStore._settled(id, 1);
    const writes = asked.filter((p) => p.endsWith("/chapters/1/script"));
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeLessThan(3);
    const server = readScript(api.db, id, 1);
    expect(server[0].text).toBe("One.");
    expect(server[1]).toMatchObject({ text: "Two.", speaker: "Narrator" });
  });

  test("a stale edit is refused: the server's script wins, and the toast says so", async () => {
    const { id } = await scriptedAndOpen();
    writeScript(api.db, id, 1, writtenElsewhere());
    scriptsStore.updateSegment(id, 1, 1, { text: "Written here." });
    await scriptsStore._settled(id, 1);
    await settle();
    expect(toasts.at(-1)?.msg).toBe("The script changed on the server");
    expect(scriptsStore.segmentsOf(id, 1).map((s) => s.text)).toEqual(["Written elsewhere."]);
    expect(scriptsStore._revision[key(id, 1)]).toBe(2);
    expect(readScript(api.db, id, 1)[0].text).toBe("Written elsewhere.");
    // the refused edit is not a script something replaced: there is no diff to show
    expect(scriptsStore._previous[key(id, 1)]).toBeUndefined();
  });

  test("a refused edit reads the server's script back even when no page has the chapter open", async () => {
    const id = await shelved();
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    // the script was read once, by a page since closed: the store keeps the copy, the query
    // cache has nothing left to refetch
    scriptsStore._install(id, 1, await libraryService().chapterScript(id, 1));
    writeScript(api.db, id, 1, writtenElsewhere());
    scriptsStore.updateSegment(id, 1, 1, { text: "Written here." });
    await scriptsStore._settled(id, 1);
    expect(toasts.at(-1)?.msg).toBe("The script changed on the server");
    expect(scriptsStore.segmentsOf(id, 1).map((s) => s.text)).toEqual(["Written elsewhere."]);
    expect(scriptsStore._revision[key(id, 1)]).toBe(2);
    expect(scriptsStore._previous[key(id, 1)]).toBeUndefined();
    // and the history with it
    expect(historyStore.historyOf(id, 1).head.origin.kind).toBe("scripted");
  });

  test("a renumbering forgets only the renumbered book's writes", async () => {
    const { id: other } = await scriptedAndOpen();
    const id = await shelved();
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    pinia.run(() => useChapterScript(id, 1));
    await settle();
    const [a, b] = scriptsStore.segmentsOf(id, 1);
    // the first write's answer is held on its way back, and a second edit is made meanwhile
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hold = (path, init) =>
      init?.method === "PUT" && path === `/api/books/${id}/chapters/1/script`
        ? held
        : Promise.resolve();
    scriptsStore.updateSegment(id, 1, a.id, { text: "One." });
    await flush();
    scriptsStore.updateSegment(id, 1, b.id, { text: "Two." });
    // the other book is renumbered: its writes are forgotten, this book's are still owed
    scriptsStore._remapBook(other, { 1: 1, 2: 2, 3: 3 });
    hold = null;
    release();
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    const server = readScript(api.db, id, 1);
    expect(server[0].text).toBe("One.");
    expect(server[1].text).toBe("Two.");
  });

  test("the revision never goes backwards, whichever answer lands last", async () => {
    const { id } = await scriptedAndOpen();
    const k = key(id, 1);
    // an edit's answer is held on its way back, and a rename moves the chapter on meanwhile
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hold = (path, init) =>
      init?.method === "PUT" && path === `/api/books/${id}/chapters/1/script`
        ? held
        : Promise.resolve();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    scriptsStore.updateSegment(id, 1, line.id, { text: "Edited first." });
    await flush();
    hold = null;
    await castStore.renameCharacter(id, "Mara", "Mara Voss");
    expect(scriptsStore._revision[k]).toBe(3);
    release();
    await scriptsStore._settled(id, 1);
    expect(scriptsStore._revision[k]).toBe(3);
    // so the next edit names the revision the chapter is really at
    scriptsStore.updateSegment(id, 1, line.id, { text: "Edited again." });
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(readScript(api.db, id, 1)[0].text).toBe("Edited again.");
    // and a cast answer older than what the store knows changes nothing
    castStore._moved(
      id,
      { characters: castStore.charactersOf(id), moved: [{ chapterId: 1, ids: [], revision: 2 }] },
      "Mara Voss",
    );
    expect(scriptsStore._revision[k]).toBe(4);
  });

  test("a read that lands while an edit is being saved waits for the save, and loses nothing", async () => {
    const { id } = await scriptedAndOpen();
    const [a, b] = scriptsStore.segmentsOf(id, 1);
    const path = `/api/books/${id}/chapters/1/script`;
    // the first write's answer is held on its way back
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hold = (p, init) => (init?.method === "PUT" && p === path ? held : Promise.resolve());
    scriptsStore.updateSegment(id, 1, a.id, { text: "Saved first." });
    await flush();
    // a narration job moved meanwhile, and the poll reads the chapter again: the server does not
    // have the edit yet, so its script must not replace the one on screen
    await invalidate({ key: keys.chapterScript(id, 1) }, "all");
    expect(scriptsStore.segmentsOf(id, 1)[0].text).toBe("Saved first.");
    // and an edit made now is still the one written after the first lands
    scriptsStore.updateSegment(id, 1, b.id, { text: "Saved second." });
    hold = null;
    asked.length = 0;
    release();
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(
      readScript(api.db, id, 1)
        .map((s) => s.text)
        .slice(0, 2),
    ).toEqual(["Saved first.", "Saved second."]);
    expect(
      scriptsStore
        .segmentsOf(id, 1)
        .map((s) => s.text)
        .slice(0, 2),
    ).toEqual(["Saved first.", "Saved second."]);
    // the read that was put off is made once the writes have landed
    expect(asked.lastIndexOf(path)).toBeGreaterThan(asked.indexOf(path));
    expect(scriptsStore._revision[key(id, 1)]).toBe(scriptRevision(api.db, id, 1)!);
  });

  test("lines a rename moved in a chapter not read yet are read with that chapter", async () => {
    const id = await shelved();
    await scriptingStore.runScripting(id, [1, 2], { quiet: true });
    await api.runner.idle();
    pinia.run(() => useChapterScript(id, 1));
    pinia.run(() => useCast(id));
    await settle();
    await castStore.renameCharacter(id, "Mara", "Mara Voss");
    // chapter 2 was never read: the rename's revision is not a script held
    expect(scriptsStore.held(id, 2)).toBe(false);
    expect(scriptsStore._revision[key(id, 2)]).toBeUndefined();
    // so a script file's preview, which reads what is not held, reads it with the new name
    await useTransferStore()._loadScripts(id, [1, 2]);
    const speakers = scriptsStore.segmentsOf(id, 2).map((s) => s.speaker);
    expect(speakers).toContain("Mara Voss");
    expect(speakers).not.toContain("Mara");
  });

  test("a flag is written to its line alone, and adds nothing to the history", async () => {
    const { id, history } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    sent.length = 0;
    await narrationStore.flagSegment(id, 1, line.id, "delivery", "softer");
    expect(readScript(api.db, id, 1)[0].flag).toMatchObject({ kind: "delivery", note: "softer" });
    // the line's flag and nothing else: no script went with it, so no revision could refuse it
    expect(sent.map((r) => r.path)).toEqual([`/api/books/${id}/chapters/1/lines/${line.id}/flag`]);
    expect(scriptsStore._revision[key(id, 1)]).toBe(2);
    expect(history.versions.value).toEqual([]);
    expect(history.head.value.origin.kind).toBe("scripted");
    await narrationStore.clearFlag(id, 1, line.id);
    expect(readScript(api.db, id, 1)[0].flag).toBeUndefined();
    expect(scriptsStore.segmentsOf(id, 1)[0].flag).toBeUndefined();
    expect(history.head.value.origin.kind).toBe("scripted");
    // a flag batch is written the same way, a line at a time, and no script goes with it
    sent.length = 0;
    scriptsStore.applyBulk(id, [{ chId: 1, segId: line.id }], {
      kind: "flag",
      flag: "pause",
      note: "",
      replace: true,
    });
    await scriptsStore._settled(id, 1);
    expect(sent.map((r) => r.path)).toEqual([`/api/books/${id}/chapters/1/lines/${line.id}/flag`]);
    expect(readScript(api.db, id, 1)[0].flag).toMatchObject({ kind: "pause" });
    expect(history.head.value.origin.kind).toBe("scripted");
  });

  test("a flag raised while the server's script moves on — a run landing clips — is kept", async () => {
    const { id } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    const line = scriptsStore.segmentsOf(id, 1)[1];
    const read = scriptsStore._revision[key(id, 1)];
    // written underneath this tab, the way every clip a run lands moves the revision on
    writeScript(api.db, id, 1, readScript(api.db, id, 1));
    await narrationStore.flagSegment(id, 1, line.id, "pause", "too long");
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(readScript(api.db, id, 1)[1].flag).toMatchObject({ kind: "pause", note: "too long" });
    expect(scriptsStore.segmentsOf(id, 1)[1].flag).toMatchObject({ kind: "pause" });
    // the store does not claim a revision whose other write it has not read
    expect(scriptsStore._revision[key(id, 1)]).toBe(read);
    // nor is a flag batch refused: it names no revision either
    const other = scriptsStore.segmentsOf(id, 1)[2];
    writeScript(api.db, id, 1, readScript(api.db, id, 1));
    scriptsStore.applyBulk(id, [{ chId: 1, segId: other.id }], {
      kind: "flag",
      flag: "delivery",
      note: "",
      replace: true,
    });
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(readScript(api.db, id, 1)[2].flag).toMatchObject({ kind: "delivery" });
  });

  test("an edit made while a flag is on its way waits for it, and is not refused for the revision it moved", async () => {
    const { id } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    const [a, b] = scriptsStore.segmentsOf(id, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // the flag is written on the server, and its answer is held on the way back
    hold = (path) => (path.endsWith("/flag") ? gate : Promise.resolve());
    const flagged = narrationStore.flagSegment(id, 1, a.id, "delivery", "softer");
    await settle();
    scriptsStore.updateSegment(id, 1, b.id, { text: "Edited while the flag was out." });
    await settle();
    release();
    await flagged;
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    const saved = readScript(api.db, id, 1);
    expect(saved[1].text).toBe("Edited while the flag was out.");
    expect(saved[0].flag).toMatchObject({ kind: "delivery", note: "softer" });
    expect(scriptsStore._revision[key(id, 1)]).toBe(scriptRevision(api.db, id, 1)!);
  });

  test("an expression moved or removed is written with its script", async () => {
    const { id, history } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    const tag = {
      id: "laugh",
      label: "Laugh",
      token: "[laugh]",
      kind: "sound" as const,
      annotationId: 1,
      at: 0,
    };
    scriptsStore.updateSegment(id, 1, line.id, { expressions: [tag] });
    await scriptsStore._settled(id, 1);
    expect(history.head.value.origin).toEqual({ kind: "edited", edits: 1 });
    narrationStore.updateExpression(id, 1, line.id, 1, { at: 2 });
    await scriptsStore._settled(id, 1);
    expect(readScript(api.db, id, 1)[0].expressions).toEqual([{ ...tag, at: 2 }]);
    expect(history.head.value.origin).toEqual({ kind: "edited", edits: 2 });
    narrationStore.updateExpression(id, 1, line.id, 1, null);
    await scriptsStore._settled(id, 1);
    expect(readScript(api.db, id, 1)[0].expressions ?? []).toEqual([]);
    // the session is back where it began, so it leaves no entry
    expect(history.versions.value).toEqual([]);
    expect(history.head.value.origin.kind).toBe("scripted");
  });

  test("an undo of an edit writes the script back, and a session that returns leaves no entry", async () => {
    const { id, history } = await scriptedAndOpen();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    const was = line.text;
    const revert = scriptsStore._editSnapshot(id, 1);
    scriptsStore.updateSegment(id, 1, line.id, { text: "A slip." });
    await scriptsStore._settled(id, 1);
    expect(history.versions.value).toHaveLength(1);
    revert();
    await scriptsStore._settled(id, 1);
    expect(readScript(api.db, id, 1)[0].text).toBe(was);
    expect(history.versions.value).toEqual([]);
    expect(history.head.value.origin.kind).toBe("scripted");
  });

  test("a checkpoint is saved on the server, and forgetting it is its undo", async () => {
    const { id, history } = await scriptedAndOpen();
    const version = await historyStore.saveCheckpoint(id, 1, "Before the cull");
    expect(version?.origin).toMatchObject({ kind: "checkpoint", name: "Before the cull" });
    expect(history.versions.value.map((v) => v.id)).toEqual([version!.id]);
    expect(toasts.at(-1)?.msg).toBe("Checkpoint saved: “Before the cull”");
    await toasts.at(-1)!.undo!();
    expect(history.versions.value).toEqual([]);
    expect(history.head.value.origin.kind).toBe("scripted");
  });

  test("undoing a restore writes the script back before it takes the speakers it added off the cast", async () => {
    const { id, history } = await scriptedAndOpen();
    const version = (await historyStore.saveCheckpoint(id, 1, "With Tobin"))!;
    await castStore.deleteCharacter(id, "Tobin");
    expect(scriptsStore.segmentsOf(id, 1).some((s) => s.speaker === "Tobin")).toBe(false);
    // the restore brings Tobin's lines back, and Tobin with them
    expect(historyStore.restore(id, 1, version.id)).toBe(true);
    await scriptsStore._settled(id, 1);
    await settle();
    expect(readScript(api.db, id, 1).some((s) => s.speaker === "Tobin")).toBe(true);
    expect(castStore.charactersOf(id).map((c) => c.name)).toContain("Tobin");
    const castOf = async () =>
      (
        await api.request<{ characters: { name: string }[] }>(`/api/books/${id}/cast`)
      ).body.characters.map((c) => c.name);
    expect(await castOf()).toContain("Tobin");
    // the undo: the script without Tobin's lines is written first, so removing Tobin from the
    // cast moves nothing and refuses nothing
    await toasts.find((t) => t.msg.startsWith("Restored chapter 1"))!.undo!();
    await settle();
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(readScript(api.db, id, 1).some((s) => s.speaker === "Tobin")).toBe(false);
    expect(castStore.charactersOf(id).map((c) => c.name)).not.toContain("Tobin");
    expect(await castOf()).not.toContain("Tobin");
    expect(history.head.value.origin.kind).toBe("edited");
  });

  test("a restore writes the restored script under its own name", async () => {
    const { id, history } = await scriptedAndOpen();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    const was = line.text;
    const version = (await historyStore.saveCheckpoint(id, 1, "As scripted"))!;
    scriptsStore.updateSegment(id, 1, line.id, { text: "Changed since." });
    await scriptsStore._settled(id, 1);
    expect(historyStore.restore(id, 1, version.id)).toBe(true);
    await scriptsStore._settled(id, 1);
    expect(readScript(api.db, id, 1)[0].text).toBe(was);
    expect(history.head.value.origin).toMatchObject({ kind: "restored", from: version.id });
    expect(history.versions.value.map((v) => v.origin.kind)).toEqual(["edited", "checkpoint"]);
  });
});

describe("the cast with a server answering", () => {
  test("a rename moves the lines on the server and here, and the next edit still writes", async () => {
    const { id, cast } = await scriptedAndOpen();
    await castStore.renameCharacter(id, "Mara", "Mara Voss");
    expect(cast.characters.value.map((c) => c.name)).toContain("Mara Voss");
    expect(scriptsStore.segmentsOf(id, 1).some((s) => s.speaker === "Mara Voss")).toBe(true);
    expect(readScript(api.db, id, 1).some((s) => s.speaker === "Mara Voss")).toBe(true);
    // the chapter's revision moved with the rename, and the store knows the new one
    const line = scriptsStore.segmentsOf(id, 1)[0];
    scriptsStore.updateSegment(id, 1, line.id, { text: "Still writable." });
    await scriptsStore._settled(id, 1);
    expect(toasts.some((t) => t.msg === "The script changed on the server")).toBe(false);
    expect(readScript(api.db, id, 1)[0].text).toBe("Still writable.");
    // undo: renamed back, on both sides
    await toasts.find((t) => t.msg.startsWith("Renamed"))!.undo!();
    expect(castStore.charactersOf(id).map((c) => c.name)).toContain("Mara");
    expect(readScript(api.db, id, 1).some((s) => s.speaker === "Mara")).toBe(true);
  });

  test("a merge and a removal can be undone exactly, line by line", async () => {
    const { id } = await scriptedAndOpen();
    const tobinLines = readScript(api.db, id, 1)
      .filter((s) => s.speaker === "Tobin")
      .map((s) => s.id);
    expect(tobinLines.length).toBeGreaterThan(0);
    await castStore.mergeCharacter(id, "Tobin", "Mara");
    expect(castStore.charactersOf(id).map((c) => c.name)).not.toContain("Tobin");
    expect(castStore.charactersOf(id).find((c) => c.name === "Mara")?.aliases).toContain("Tobin");
    expect(readScript(api.db, id, 1).some((s) => s.speaker === "Tobin")).toBe(false);
    await toasts.at(-1)!.undo!();
    expect(castStore.charactersOf(id).map((c) => c.name)).toContain("Tobin");
    expect(castStore.charactersOf(id).find((c) => c.name === "Mara")?.aliases).not.toContain(
      "Tobin",
    );
    expect(
      readScript(api.db, id, 1)
        .filter((s) => s.speaker === "Tobin")
        .map((s) => s.id),
    ).toEqual(tobinLines);
    expect(
      scriptsStore
        .segmentsOf(id, 1)
        .filter((s) => s.speaker === "Tobin")
        .map((s) => s.id),
    ).toEqual(tobinLines);

    await castStore.deleteCharacter(id, "Tobin");
    expect(readScript(api.db, id, 1).some((s) => s.speaker === "Tobin")).toBe(false);
    await toasts.at(-1)!.undo!();
    expect(
      readScript(api.db, id, 1)
        .filter((s) => s.speaker === "Tobin")
        .map((s) => s.id),
    ).toEqual(tobinLines);
  });

  test("removing several speakers is one toast, and its one undo puts every line back", async () => {
    const { id } = await scriptedAndOpen();
    const linesOf = (name: string) =>
      readScript(api.db, id, 1)
        .filter((s) => s.speaker === name)
        .map((s) => s.id);
    const mara = linesOf("Mara");
    const tobin = linesOf("Tobin");
    expect(mara.length && tobin.length).toBeGreaterThan(0);
    const before = toasts.length;
    // the Narrator and a name the cast does not have are passed over, not refused
    await castStore.removeMany(id, ["Mara", "Narrator", "Nobody", "Tobin"]);
    expect(toasts.slice(before).map((t) => t.msg)).toEqual([
      `Removed 2 speakers · ${mara.length + tobin.length} lines now read by the Narrator`,
    ]);
    expect(castStore.charactersOf(id).map((c) => c.name)).not.toContain("Mara");
    expect(castStore.charactersOf(id).map((c) => c.name)).toContain("Narrator");
    expect(linesOf("Mara")).toEqual([]);
    expect(linesOf("Tobin")).toEqual([]);
    await toasts.at(-1)!.undo!();
    expect(castStore.charactersOf(id).map((c) => c.name)).toEqual(
      expect.arrayContaining(["Mara", "Tobin"]),
    );
    expect(linesOf("Mara")).toEqual(mara);
    expect(linesOf("Tobin")).toEqual(tobin);
  });

  test("a removal the server refuses ends the run, and what went before it can still be undone", async () => {
    const { id } = await scriptedAndOpen();
    const linesOf = (name: string) =>
      readScript(api.db, id, 1)
        .filter((s) => s.speaker === name)
        .map((s) => s.id);
    const mara = linesOf("Mara");
    const tobin = linesOf("Tobin");
    // the server refuses Tobin, and is asked about no one after
    const real = castStore._service();
    const asked: string[] = [];
    castStore._service = () =>
      Object.assign(Object.create(real) as typeof real, {
        deleteCharacter: (bookId: string, name: string) => {
          asked.push(name);
          return name === "Tobin"
            ? Promise.reject(new Error("offline"))
            : real.deleteCharacter(bookId, name);
        },
      });
    castStore.addCharacter(id, "Ines");
    await settle();
    const before = toasts.length;
    await castStore.removeMany(id, ["Mara", "Tobin", "Ines"]);
    expect(asked).toEqual(["Mara", "Tobin"]);
    const said = toasts.slice(before);
    expect(said.filter((t) => t.kind === "error").map((t) => t.msg)).toEqual([
      "Could not remove this speaker",
    ]);
    expect(said.filter((t) => t.undo).map((t) => t.msg)).toEqual([
      `Removed “Mara” · ${mara.length} line${mara.length === 1 ? "" : "s"} now read by the Narrator`,
    ]);
    expect(linesOf("Mara")).toEqual([]);
    expect(linesOf("Tobin")).toEqual(tobin);
    expect(castStore.charactersOf(id).map((c) => c.name)).toEqual(
      expect.arrayContaining(["Tobin", "Ines"]),
    );
    await said.find((t) => t.undo)!.undo!();
    expect(linesOf("Mara")).toEqual(mara);
    expect(castStore.charactersOf(id).map((c) => c.name)).toContain("Mara");
  });

  test("what is said about a speaker is written as stated, and the dictionary whole", async () => {
    const { id } = await scriptedAndOpen();
    await castStore.updateCharacter(id, "Mara", { gender: "f", major: true });
    await castStore.keepCharacter(id, "Tobin");
    wireStores();
    const cast = pinia.run(() => useCast(id));
    await settle();
    expect(cast.characters.value.find((c) => c.name === "Mara")).toMatchObject({
      gender: "f",
      major: true,
    });
    expect(cast.characters.value.find((c) => c.name === "Tobin")).toMatchObject({ keep: true });
    expect(cast.characters.value.find((c) => c.name === "Tobin")?.isNew).toBeUndefined();

    castStore.addTerm(id, "Voss", "Vohss");
    await settle();
    wireStores();
    const again = pinia.run(() => useCast(id));
    await settle();
    expect(again.lexicon.value).toEqual([{ id: 1, term: "Voss", say: "Vohss", enabled: true }]);
  });
});

describe("narration with a server answering", () => {
  test("a run is queued on the server, and the clips arrive with files to play", async () => {
    const { id } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    narrationStore.runNarration(id, [1]);
    await settle();
    expect(toasts.at(-1)?.msg).toBe("Narrate · 1 chapter");
    expect(jobsStore.jobs.map((j) => j.kind)).toContain("narration");
    expect(libraryStore.chapter(id, 1)?.narration).toBeOneOf(["queued", "running"]);
    await api.runner.idle();
    await poll();
    const segs = scriptsStore.segmentsOf(id, 1);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) {
      expect(s.audio.status).toBe("done");
      expect(s.audio.duration).toBeGreaterThan(0);
      expect(s.audio.url ?? "").toStartWith(`/api/audio/${id}/`);
    }
    expect(libraryStore.chapter(id, 1)?.narration).toBe("done");
    expect(libraryStore.chapter(id, 1)?.duration).toBeGreaterThan(0);
    expect(jobsStore.jobs.find((j) => j.kind === "narration")?.status).toBe("done");
    // the file behind the url is served, so the player hears it rather than timing it
    const res = await api.fetch(segs[0].audio.url!, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    // the revision moved with every clip that landed; that is not a re-script, so there is no diff
    expect(scriptsStore._revision[key(id, 1)]).toBeGreaterThan(1);
    expect(scriptsStore._previous[key(id, 1)]).toBeUndefined();
    // and the store read the revision the clips moved it to, so the next edit still writes
    scriptsStore.updateSegment(id, 1, segs[0].id, { text: "Edited after narration." });
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(readScript(api.db, id, 1)[0].text).toBe("Edited after narration.");
  });

  test("a pacing change re-times a narrated chapter as the server does, even one not opened here", async () => {
    const { id } = await narrated();
    const length = libraryStore.chapter(id, 1)!.duration;
    expect(length).toBeGreaterThan(0);

    // a reload: the book is open but chapter 1's script has not been read, so its clips are not here
    wireStores();
    await libraryStore.load();
    await libraryStore.loadBook(id);
    expect(scriptsStore.segmentsOf(id, 1)).toEqual([]);
    await castStore.setPacing(id, { line: 3, turn: 3 });
    const segs = readScript(api.db, id, 1);
    const expected =
      segs.reduce((a, s) => a + s.audio.duration, 0) +
      silenceOf(segs, { line: 3, turn: 3 }, undefined);
    // not the length of silence alone, which is what re-timing it from no clips would give
    expect(libraryStore.chapter(id, 1)?.duration).toBeCloseTo(expected, 6);
    expect(libraryStore.chapter(id, 1)?.duration).toBeGreaterThan(length);
    // an unnarrated chapter keeps the length it had
    expect(libraryStore.chapter(id, 2)?.duration).toBe(0);

    wireStores();
    await libraryStore.load();
    await libraryStore.loadBook(id);
    expect(libraryStore.bookById(id)?.pacing).toEqual({ line: 3, turn: 3 });
    expect(libraryStore.chapter(id, 1)?.duration).toBeCloseTo(expected, 6);
  });

  test("a reload counts a chapter's lines and each endpoint's clips without reading a script", async () => {
    const { id } = await narrated();
    // the clips as one endpoint of the server's rendered them, the last of them failed
    const segs = readScript(api.db, id, 1);
    for (const s of segs) s.audio.endpoint = studio.id;
    segs.at(-1)!.audio.status = "failed";
    writeScript(api.db, id, 1, segs);
    const { status } = await api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [studio], profiles: [], credentials: [] }),
      method: "PUT",
    });
    expect(status).toBe(200);
    // a reload that opens the Queue first: the book is listed, no script has been read
    wireStores({ endpoints: true });
    await libraryStore.loadBook(id);
    await useEndpointsStore().load();
    pinia.run(() => useEndpointLive());
    await settle();
    expect(scriptsStore.held(id, 1)).toBe(false);
    const done = segs.length - 1;
    expect(scriptsStore.lineCountsOf(id, 1)).toEqual({
      total: segs.length,
      done,
      generating: 0,
      failed: 1,
      skipped: 0,
    });
    expect(scriptsStore.lineCountsOf(id, 2)).toEqual({
      total: 0,
      done: 0,
      generating: 0,
      failed: 0,
      skipped: 0,
    });
    expect(jobsStore.endpointLoad.studio).toMatchObject({ done, failed: 1 });
    // once the script is here, it is what is counted, and it follows an edit before the server does
    pinia.run(() => useChapterScript(id, 1));
    await settle();
    scriptsStore.deleteSegment(id, 1, segs[0].id);
    expect(scriptsStore.lineCountsOf(id, 1)?.total).toBe(segs.length - 1);
    await scriptsStore._settled(id, 1);
  });

  test("re-narrating what changed renders only those lines, and keeps the rest", async () => {
    const { id, narrationStore } = await narrated();
    await voiced(id);
    const before = scriptsStore.segmentsOf(id, 1).map((s) => s.audio.url);
    const [a] = scriptsStore.segmentsOf(id, 1);
    scriptsStore.updateSegment(id, 1, a.id, { text: "Changed since it was rendered." });
    await scriptsStore._settled(id, 1);
    expect(scriptsStore.segmentsOf(id, 1)[0].audio.status).toBe("stale");
    narrationStore.renarrateStale(id, 1);
    await settle();
    await api.runner.idle();
    await poll();
    const segs = scriptsStore.segmentsOf(id, 1);
    expect(segs[0].audio.status).toBe("done");
    expect(segs[0].audio.url).not.toBe(before[0]);
    // the stale clip stayed playable while its replacement rendered, and is a take now
    expect(segs[0].audio.takes?.map((t) => t.url)).toEqual([before[0]]);
    expect(segs.slice(1).map((s) => s.audio.url)).toEqual(before.slice(1));
    expect(libraryStore.chapter(id, 1)?.narration).toBe("done");
    // nothing left in the scope: the server says so rather than queueing an empty run
    narrationStore.runNarration(id, [1], { scope: "fill" });
    await settle();
    expect(toasts.at(-1)?.msg).toBe("Nothing to narrate in this selection");
    expect(toasts.at(-1)?.kind).toBe("warn");
  });

  test("a failed line is retried at the failed scope", async () => {
    // a provider that fails one line once, so the retry has something to succeed at
    const inner = fakeSpeechProvider();
    let failedOnce = false;
    const speech: SpeechProvider = {
      name: inner.name,
      speak(input) {
        if (!failedOnce && input.text.includes("count it twice")) {
          failedOnce = true;
          throw new Error("The voice service dropped the connection");
        }
        return inner.speak(input);
      },
    };
    wire({ speech });
    const { id, narrationStore } = await narrated();
    const broken = scriptsStore.segmentsOf(id, 1).find((s) => s.text.includes("count it twice"))!;
    expect(broken.audio.status).toBe("failed");
    expect(broken.audio.error?.message).toContain("dropped");
    expect(scriptsStore.segmentsOf(id, 1).filter((s) => s.audio.status === "done").length).toBe(
      scriptsStore.segmentsOf(id, 1).length - 1,
    );
    expect(libraryStore.chapter(id, 1)?.narration).toBe("failed");
    expect(jobsStore.jobs.find((j) => j.kind === "narration")?.status).toBe("failed");
    await voiced(id);
    // one line, retried by hand: the server re-renders the chapter's failed lines
    narrationStore.retrySegment(id, 1, broken.id);
    await settle();
    await api.runner.idle();
    await poll();
    expect(scriptsStore.segmentsOf(id, 1).every((s) => s.audio.status === "done")).toBe(true);
    expect(libraryStore.chapter(id, 1)?.narration).toBe("done");
  });
});

describe("the dictionary with a server answering", () => {
  /** The line the dictionary below reaches: no other line of chapter 1 says "twice". */
  const twice = (segs: Segment[]) => segs.find((s) => s.text.includes("count it twice"))!;

  test("a line the dictionary respells is narrated as respelled, and its clip reads as fresh", async () => {
    const { id } = await scriptedAndOpen();
    castStore.addTerm(id, "twice", "twyce");
    await settle();
    const narrationStore = useNarrationStore();
    await narrationStore.runNarration(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    const line = twice(scriptsStore.segmentsOf(id, 1));
    expect(line.audio.status).toBe("done");
    expect(line.audio.pronounced).toContain("twyce");
    expect(line.audio.said).toContain("twyce");
    expect(line.audio.lex).toBe(1);
    // what the clip says it was sent is what the dictionary sends now, so nothing has drifted
    expect(narrationStore.clipDrift(id, line)).toEqual([]);
    expect(twice(readScript(api.db, id, 1)).audio.pronounced).toContain("twyce");
    // a line the dictionary leaves alone records what it was sent too, and no respelling
    const plain = scriptsStore.segmentsOf(id, 1).find((s) => s !== line)!;
    expect(plain.audio.pronounced).toBeDefined();
    expect(plain.audio.said).toBeUndefined();
    expect(libraryStore.chapter(id, 1)?.narration).toBe("done");
  });

  test("a term that reaches a narrated line stales its clip on both sides, and the next edit still writes", async () => {
    const { id } = await narrated();
    castStore.addTerm(id, "twice", "twyce");
    await settle();
    expect(twice(scriptsStore.segmentsOf(id, 1)).audio.status).toBe("stale");
    expect(twice(readScript(api.db, id, 1)).audio.status).toBe("stale");
    // only that line: the others still read what the dictionary sends
    expect(readScript(api.db, id, 1).filter((s) => s.audio.status === "stale")).toHaveLength(1);
    expect(libraryStore.chapter(id, 1)?.narration).toBe("stale");
    expect(toasts.at(-1)?.kind).toBe("warn");
    // the store adopted the revision the change moved the chapter to
    const [a] = scriptsStore.segmentsOf(id, 1);
    scriptsStore.updateSegment(id, 1, a.id, { text: "Edited after the dictionary." });
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(readScript(api.db, id, 1)[0].text).toBe("Edited after the dictionary.");
  });

  test("undoing that term puts the clip back to done on the server too", async () => {
    const { id } = await narrated();
    castStore.addTerm(id, "twice", "twyce");
    await settle();
    expect(twice(readScript(api.db, id, 1)).audio.status).toBe("stale");
    await toasts.at(-1)!.undo!();
    await settle();
    expect(castStore.lexiconOf(id)).toEqual([]);
    expect(twice(scriptsStore.segmentsOf(id, 1)).audio.status).toBe("done");
    expect(twice(readScript(api.db, id, 1)).audio.status).toBe("done");
    expect(libraryStore.chapter(id, 1)?.narration).toBe("done");
    // the Undo named the lines the change staled, and nothing else
    const [undo] = sent.filter((r) => r.path === `/api/books/${id}/lexicon`).slice(-1);
    expect(undo.body).toMatchObject({
      entries: [],
      restore: [{ chapterId: 1, ids: [twice(readScript(api.db, id, 1)).id] }],
    });
    // and the revision it moved to was adopted as well
    const [a] = scriptsStore.segmentsOf(id, 1);
    scriptsStore.updateSegment(id, 1, a.id, { text: "Edited after the Undo." });
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
  });

  test("an Undo clicked before the change is answered still puts the clip back", async () => {
    const { id } = await narrated();
    castStore.addTerm(id, "twice", "twyce");
    await toasts.at(-1)!.undo!();
    await settle();
    expect(castStore.lexiconOf(id)).toEqual([]);
    expect(twice(scriptsStore.segmentsOf(id, 1)).audio.status).toBe("done");
    expect(twice(readScript(api.db, id, 1)).audio.status).toBe("done");
    wireStores();
    const cast = pinia.run(() => useCast(id));
    await settle();
    expect(cast.lexicon.value).toEqual([]);
  });
});

describe("the Narration page's reads", () => {
  test("nothing reads as ready until the cast, the scripts and the endpoints are all in; a failed read says so and retries", async () => {
    const { id } = await scriptedAndOpen();
    // a reload: fresh stores, nothing read yet
    wireStores({ endpoints: true });
    await useEndpointsStore().load();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hold = async (path) => {
      if (path.endsWith("/cast")) await gate;
    };
    const data = pinia.run(() => useNarrationData(id, 1));
    await settle();
    // the scripts are here and the cast is not: an empty cast is not a cast with no voices
    expect(scriptsStore.held(id, 1)).toBe(true);
    expect(data.ready.value).toBe(false);
    expect(data.error.value).toBeNull();
    release();
    await settle();
    expect(data.ready.value).toBe(true);

    // a cast that could not be read is an error with a retry, never an empty cast
    wireStores({ endpoints: true });
    await useEndpointsStore().load();
    hold = async (path) => {
      if (path.endsWith("/cast")) throw new Error("offline");
    };
    const failed = pinia.run(() => useNarrationData(id, 1));
    await settle();
    expect(failed.ready.value).toBe(false);
    expect(failed.error.value).toBe("The cast could not be read.");
    hold = null;
    await failed.retry();
    await settle();
    expect(failed.ready.value).toBe(true);
  });

  test("an endpoint configuration that could not be read is an error, not an empty pool", async () => {
    const { id } = await scriptedAndOpen();
    wireStores({ endpoints: true });
    // what the router's read leaves behind when it failed
    const data = pinia.run(() => useNarrationData(id, 1));
    await settle();
    expect(useEndpointsStore().loaded).toBe(false);
    expect(data.ready.value).toBe(false);
    expect(data.error.value).toBe("The endpoint configuration could not be read.");
    await data.retry();
    await settle();
    expect(data.ready.value).toBe(true);
  });
});

describe("retakes with a server answering", () => {
  test("a retake renders beside the clip and waits for a verdict; keeping it swaps the two", async () => {
    const { id, narrationStore } = await narrated();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    const before = clone(line.audio);
    narrationStore.flagSegment(id, 1, line.id, "delivery", "too flat");
    await scriptsStore._settled(id, 1);
    narrationStore.retakeSegment(id, 1, line.id);
    await settle();
    expect(toasts.at(-1)?.msg).toBe("Retake · 1 line");
    expect(jobsStore.jobs.at(-1)?.label).toBe("Retake");
    await api.runner.idle();
    await poll();
    // the candidate landed with a file, and the clip in the book is untouched
    const waiting = scriptsStore.segmentsOf(id, 1)[0];
    expect(waiting.candidate).toMatchObject({ status: "done", n: 2 });
    expect(waiting.candidate?.url).toStartWith(`/api/audio/${id}/`);
    expect(waiting.candidate?.url).not.toBe(before.url);
    expect(waiting.audio.url).toBe(before.url);
    expect(waiting.flag?.kind).toBe("delivery");
    expect(libraryStore.chapter(id, 1)?.narration).toBe("done");

    narrationStore.acceptTake(id, 1, line.id);
    await settle();
    expect(toasts.at(-1)?.msg).toBe("Take 2 kept");
    expect(toasts.at(-1)?.undo).toBeNull();
    const kept = scriptsStore.segmentsOf(id, 1)[0];
    expect(kept.audio.url).toBe(waiting.candidate!.url);
    expect(kept.audio.n).toBe(2);
    expect(kept.candidate).toBeUndefined();
    expect(kept.flag).toBeUndefined();
    // the displaced clip is a take, with its file, on both sides
    expect(kept.audio.takes?.map((t) => t.url)).toEqual([before.url]);
    const server = readScript(api.db, id, 1)[0];
    expect(server.audio.url).toBe(kept.audio.url);
    expect(server.audio.takes?.map((t) => t.url)).toEqual([before.url]);
    expect(server.flag).toBeUndefined();
    // the store read the revision the verdict moved it to, so the next edit still writes
    scriptsStore.updateSegment(id, 1, line.id, { text: "Edited after the verdict." });
    await scriptsStore._settled(id, 1);
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
  });

  test("discarding a retake keeps the clip in the book and marks the take rejected", async () => {
    const { id, narrationStore } = await narrated();
    const line = scriptsStore.segmentsOf(id, 1)[1];
    const before = clone(line.audio);
    narrationStore.retakeSegment(id, 1, line.id);
    await settle();
    await api.runner.idle();
    await poll();
    expect(scriptsStore.segmentsOf(id, 1)[1].candidate?.status).toBe("done");
    narrationStore.rejectTake(id, 1, line.id);
    await settle();
    expect(toasts.at(-1)?.msg).toBe("Take 1 kept");
    const kept = scriptsStore.segmentsOf(id, 1)[1];
    expect(kept.audio.url).toBe(before.url);
    expect(kept.candidate).toBeUndefined();
    expect(kept.audio.takes?.map((t) => [t.n, t.rejected])).toEqual([[2, true]]);
    expect(readScript(api.db, id, 1)[1].audio.takes?.map((t) => t.rejected)).toEqual([true]);
  });

  test("retaking the flagged lines queues each once, and a line already waiting is left alone", async () => {
    const { id, narrationStore } = await narrated();
    const [a, b] = scriptsStore.segmentsOf(id, 1);
    narrationStore.flagSegment(id, 1, a.id, "pause", "");
    narrationStore.flagSegment(id, 1, b.id, "other", "hmm");
    await scriptsStore._settled(id, 1);
    narrationStore.retakeFlagged(id, 1);
    await settle();
    expect(toasts.at(-1)?.msg).toBe("Retake · 2 lines");
    await api.runner.idle();
    await poll();
    expect(
      scriptsStore.segmentsOf(id, 1).filter((s) => s.candidate?.status === "done"),
    ).toHaveLength(2);
    // asked again while both wait: nothing is queued, and the toast says why
    narrationStore.retakeFlagged(id, 1);
    await settle();
    expect(toasts.at(-1)?.msg).toBe("Nothing to retake");
    expect(jobsStore.jobs.filter((j) => j.label === "Retake")).toHaveLength(1);
  });
});

describe("the audiobooks with a server answering", () => {
  test("are the server's, which starts with none", async () => {
    const id = await shelved();
    const exportsStore = useExportsStore();
    expect(exportsStore.exports).toEqual([]);
    const exports = pinia.run(() => useBookExports(id));
    await settle();
    expect(exports.status.value).toBe("success");
    expect(exports.exports.value).toEqual([]);
  });

  test("a build is a job the server runs, and the page shows the version it is writing", async () => {
    const { id } = await scriptedAndOpen();
    const exportsStore = useExportsStore();
    const narrationStore = useNarrationStore();
    narrationStore.runNarration(id, [1]);
    await settle();
    await api.runner.idle();
    await poll();

    const exports = pinia.run(() => useBookExports(id));
    await settle();

    const settings = { ...DEFAULT_EXPORT_SETTINGS, title: "One", filename: "One" };
    const entry = await exportsStore.buildExport(id, [1], settings);
    // the version goes up as the server made it, before a byte of it has been written
    expect(entry?.status).toBe("building");
    expect(entry?.version).toBe(1);
    expect(sent.at(-1)?.path).toBe(`/api/books/${id}/exports`);
    expect(jobsStore.jobs.map((j) => j.kind)).toContain("export");

    await api.runner.idle();
    await poll();
    // the poll noticed the job move and read the audiobooks again, so the tab is current without
    // the page having asked for anything
    const [done] = exports.exports.value;
    expect(done.status).toBe("done");
    expect(done.size).toBeGreaterThan(0);
    expect(done.files[0].name).toEndWith(".wav");
    // and the file behind it is served, so "Download" hands over something real
    const file = await api.fetch(`/api/books/${id}/exports/${done.id}/files/0`, {});
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain(done.files[0].name);
  });

  test("a chapter with no audio is refused in the server's words, and nothing is marked", async () => {
    const { id } = await scriptedAndOpen();
    const exportsStore = useExportsStore();

    const settings = { ...DEFAULT_EXPORT_SETTINGS, title: "One", filename: "One" };
    // chapter 1 is scripted but never narrated, so there is nothing to put in the file
    const entry = await exportsStore.buildExport(id, [1], settings);
    expect(entry).toBeNull();
    // the refusal is the review's own blocker, carried back rather than reworded here
    expect(toasts.at(-1)?.msg).toContain("no audio");
    expect(exportsStore.exports).toEqual([]);
    expect(jobsStore.jobs.some((j) => j.kind === "export")).toBe(false);
  });
});

describe("spending with a server answering", () => {
  /** An OpenAI profile, priced, saved to the server the way the Endpoints page saves it. */
  async function priced(): Promise<void> {
    const profile = openaiProfile();
    const { status } = await api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [], profiles: [profile], credentials: makeCredentials() }),
      method: "PUT",
    });
    expect(status).toBe(200);
    // and held by the page, which is where a run's profile is picked from
    useEndpointsStore().profiles = [profile];
    scriptingStore.scriptSettings.profile = profile.id;
  }

  const serverSpend = async (id: string) =>
    (await api.request<{ spend: BookSpend }>(`/api/books/${id}/spend`)).body.spend;

  test("a run's cost reaches every budget figure from the server's ledger as its job moves", async () => {
    await priced();
    const id = await shelved(["One"]);
    // open before the run, as the shell holds the open book's spending: the job moving is what
    // has it read again
    pinia.run(() => useBookSpend(id));
    await settle();
    expect(jobsStore.spent(id)).toBe(0);
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    const spend = await serverSpend(id);
    expect(spend.spent).toBeGreaterThan(0);
    expect(jobsStore.spent(id)).toBe(spend.spent);
    expect(jobsStore.scriptSpent(id)).toBe(spend.scriptSpent);
    expect(jobsStore.reserved(id)).toBe(spend.reserved);
    // and the Scripting page's activity figures for the profile are the same ledger rows
    useEndpointsStore().profiles = [openaiProfile()];
    const activity = pinia.run(() => useScriptActivity());
    await settle();
    const rows = activity.rowsOf("openai");
    expect(rows.length).toBeGreaterThan(0);
    expect(scriptUsageTotals(rows).cost).toBeCloseTo(spend.scriptSpent, 12);
    expect(scriptTelemetry(rows, useEndpointsStore().profiles[0]).completed).toBe(rows.length);
  });

  test("a run the server refuses for its budget says the server's sentence and queues nothing", async () => {
    await priced();
    const id = await shelved(["One"]);
    await libraryStore.setBudgetCap(id, 0.0001);
    scriptingStore.runScripting(id, [1]);
    await settle();
    const refusal = toasts.at(-1)!;
    expect(refusal.kind).toBe("error");
    expect(refusal.msg).toMatch(/^Over the book's .+ cap: .+ for this run/);
    expect(jobsStore.jobs).toEqual([]);
    expect(libraryStore.chapter(id, 1)?.scripting).toBe("none");
  });

  test("the Endpoints page's history is the ledger's rows", async () => {
    await priced();
    const id = await shelved(["One"]);
    await scriptingStore.runScripting(id, [1], { quiet: true });
    await api.runner.idle();
    const ep = {
      key: "scripting:openai",
      id: "openai",
      kind: "scripting",
    } satisfies EndpointDescriptor;
    const history = pinia.run(() => useEndpointHistory([ep]));
    await settle();
    const { body } = await api.request<{ requests: RequestRecord[] }>(
      "/api/endpoints/requests?kind=scripting&id=openai&range=7d",
    );
    expect(body.requests.length).toBeGreaterThan(0);
    expect(history.histories.value[ep.key]).toEqual(body.requests);
    // the fake provider answered, so each row says it was simulated
    expect(body.requests.every((r) => r.simulated && r.bookId === id)).toBe(true);
  });
});

describe("the speech endpoints' live telemetry with a server answering", () => {
  /**
   * A server holding one speech endpoint whose narration the test holds open, the stores reading
   * the configuration from it, and a page showing the endpoints' live telemetry.
   */
  async function narrating() {
    const speech = gatedSpeechProvider();
    wire({ speech: speech.provider }, { endpoints: true });
    const { status } = await api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [studio], profiles: [], credentials: [] }),
      method: "PUT",
    });
    expect(status).toBe(200);
    const endpointsStore = useEndpointsStore();
    await endpointsStore.load();
    pinia.run(() => useEndpointLive());
    const { id } = await scriptedAndOpen();
    void useNarrationStore().runNarration(id, [1], { quiet: true });
    await speech.started;
    await poll();
    // two lines at the gate for the endpoint, one out and one held behind it, then a rate limit
    const stop = new AbortController();
    const limits = () => ({ concurrency: 1, enabled: true });
    const out = await api.gate.acquire("studio", limits, { signal: stop.signal });
    void api.gate.acquire("studio", limits, { signal: stop.signal }).catch(() => {});
    api.gate.rateLimited("studio", 5000);
    const done = async () => {
      stop.abort();
      out();
      speech.release();
      await api.runner.idle();
    };
    return { endpointsStore, ep: endpointsStore.endpoints[0], done };
  }
  const liveReads = () => asked.filter((path) => path === "/api/endpoints/live").length;

  test("the server's counts and cooldown land on the endpoint, and the cooldown is why lines wait", async () => {
    const { endpointsStore, ep, done } = await narrating();
    await poll();
    expect(endpointsStore.live.studio).toMatchObject({ active: 1, waiting: 1, rateLimits: 1 });
    expect(ep.rateLimits).toBe(1);
    expect(ep.backoffUntil).toBeGreaterThan(Date.now());
    // the Endpoints page's card and the Queue page's pool read the server's numbers
    const { liveActivity } = pinia.run(() => useEndpointActivity());
    expect(liveActivity(unifyEndpoint(ep))).toEqual({
      active: 1,
      queued: 1,
      waiting: "cooldown",
      effectiveLimit: 0,
    });
    expect(useJobsStore().endpointLoad.studio).toMatchObject({ active: 1, backoff: true });
    await done();
  });

  test("the telemetry is read while narration runs, once after it ends, and not again", async () => {
    const { ep, done } = await narrating();
    const before = liveReads();
    await poll();
    await poll();
    expect(liveReads()).toBe(before + 2);
    await done();
    await poll();
    // the read after the last job finished: the lines are let go, the cooldown is still the gate's
    expect(liveReads()).toBe(before + 3);
    expect(useEndpointsStore().live.studio).toMatchObject({ active: 0, waiting: 0 });
    expect(ep.backoffUntil).toBeGreaterThan(Date.now());
    await poll();
    await poll();
    expect(liveReads()).toBe(before + 3);
  });

  test("telemetry arriving sends no save, and a save sends none of it", async () => {
    const { endpointsStore, ep, done } = await narrating();
    await poll();
    expect(ep.backoffUntil).toBeGreaterThan(0);
    // a write waiting behind its timer is sent now rather than after it: none is waiting
    await endpointsStore.flushWrites();
    const saves = () => sent.filter((s) => s.path === "/api/endpoints");
    expect(saves()).toEqual([]);
    ep.concurrency = 3;
    await settle();
    await endpointsStore.flushWrites();
    expect(saves()).toHaveLength(1);
    const [saved] = (saves()[0].body as { endpoints: Record<string, unknown>[] }).endpoints;
    expect(saved.concurrency).toBe(3);
    for (const k of ["rateLimits", "backoffUntil", "history", "failures", "active", "waiting"])
      expect(saved).not.toHaveProperty(k);
    // and what the server answered did not wipe what the gate said
    expect(ep.backoffUntil).toBeGreaterThan(Date.now());
    await done();
  });
});
