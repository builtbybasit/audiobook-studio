// The jobs and scripting stores against the real API.
//
// `libraryBackend.test.ts` next door proves the library store's backend half. This is the queue's:
// the stores the Queue and Scripting pages read, driven through the real `HttpJobsService` and
// `HttpLibraryService` against the real Hono app, the real runner and a fake scripting model, over
// a private in-memory database. What these guard is the mode rule — with a server answering, no
// job and no script on screen may come from `@/mock` — and that what the screens show is what the
// server holds, not what the store assumed when it sent the request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { HttpJobsService, setJobsService } from "@/services/jobs";
import { HttpLibraryService, setLibraryService } from "@/services/library";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { epubFile, story } from "./support/epub";
import { gatedProvider, testApi, type TestApi } from "./support/server";

let api: TestApi;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let toasts: { msg: string; kind?: string }[];

const volume = (titles: string[]) =>
  epubFile({
    chapters: titles.map((title) => ({
      title,
      paragraphs: ["“We are short again,” said Mara.", ...story()],
    })),
  });

/** Let a fire-and-forget store action's requests land: they are in-process, so one turn is enough. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function wire(options: Parameters<typeof testApi>[0] = {}) {
  api = testApi(options);
  wireStores();
}

/** Fresh stores over the same server, as a reload would give. */
function wireStores() {
  // the seeded world reaches for `matchMedia` as it is built; the stores must not build one at all
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  // The services go in before the stores are created: a store reads its service while building
  // its state, which is how it knows not to seed itself from the demo world.
  setLibraryService(new HttpLibraryService("/api", api.fetch));
  setJobsService(new HttpJobsService("/api", api.fetch));
  setActivePinia(createPinia());
  libraryStore = useLibraryStore();
  jobsStore = useJobsStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  toasts = [];
  const uiStore = useUiStore();
  uiStore.toast = (msg, opts = {}) => {
    toasts.push({ msg, kind: opts.kind });
    return "";
  };
}

/** A shelved book with three chapters, through the store. */
async function shelved(titles = ["One", "Two", "Three"]): Promise<string> {
  const id = (await libraryStore.importBook({ source: await volume(titles) }))!;
  await libraryStore.confirmImport(id);
  return id;
}

beforeEach(() => wire());

// The services are module state, and every other suite in this repository is the seeded world.
afterEach(() => {
  jobsStore.stopPolling();
  setLibraryService(null);
  setJobsService(null);
});

describe("the queue with a server answering", () => {
  test("starts empty rather than on the seeded history", async () => {
    expect(jobsStore.jobs).toEqual([]);
    await jobsStore.load();
    expect(jobsStore.jobs).toEqual([]);
    expect(jobsStore.loaded).toBe(true);
    // and so does the script store: a real library has no seeded scripts
    expect(Object.keys(scriptsStore.segments)).toEqual([]);
  });

  test("a scripting run is queued on the server, and the chapters say so at once", async () => {
    const gate = gatedProvider();
    wire({ scripting: gate.provider });
    const id = await shelved();
    scriptingStore.runScripting(id, [1, 2]);
    await settle();
    // the toast, and the two jobs the server made
    expect(toasts.at(-1)?.msg).toBe("Script · 2 chapters");
    expect(jobsStore.jobs.map((j) => [j.kind, j.chapterId])).toEqual([
      ["scripting", 1],
      ["scripting", 2],
    ]);
    expect(jobsStore.activeJobs).toHaveLength(2);
    // nothing here came from the simulator: the chapters were marked by the server's answer
    expect(libraryStore.chapter(id, 1)?.scripting).toBe("running");
    expect(libraryStore.chapter(id, 2)?.scripting).toBe("queued");
    gate.release();
    await api.runner.idle();
  });

  test("the script arrives in the store when the job lands, and the chapter reads as scripted", async () => {
    const id = await shelved();
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await jobsStore.refresh();
    expect(jobsStore.jobs[0].status).toBe("done");
    expect(libraryStore.chapter(id, 1)?.scripting).toBe("done");
    const segs = scriptsStore.segmentsOf(id, 1);
    expect(segs.length).toBeGreaterThan(1);
    // the fake model's attribution, which nothing in the seeded world produces
    expect(segs.find((s) => s.type === "dialogue")?.speaker).toBe("Mara");
    expect(scriptsStore.scriptLoaded(id, 1)).toBe(true);
    // a chapter nothing has scripted stays unscripted and unread
    expect(libraryStore.chapter(id, 2)?.scripting).toBe("none");
    expect(scriptsStore.segmentsOf(id, 2)).toEqual([]);
  });

  test("opening a scripted chapter reads its script once", async () => {
    const id = await shelved();
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    // a fresh store, as a reload would give: nothing until it is asked for
    wireStores();
    await libraryStore.loadBook(id);
    expect(scriptsStore.segmentsOf(id, 1)).toEqual([]);
    await scriptsStore.loadScript(id, 1);
    expect(scriptsStore.segmentsOf(id, 1).length).toBeGreaterThan(0);
  });

  test("the first read of the queue is history, not change: nothing is fetched on its account", async () => {
    const id = await shelved();
    await scriptingStore._runRemote(id, [1, 2], { quiet: true });
    await api.runner.idle();
    // a reload: fresh stores over the same server, counting what the queue's first read asks for
    const asked: string[] = [];
    const counted = api.fetch;
    api = { ...api, fetch: (input, init) => (asked.push(input), counted(input, init)) };
    wireStores();
    await libraryStore.loadBook(id);
    asked.length = 0;
    await jobsStore.load();
    expect(jobsStore.jobs).toHaveLength(2);
    expect(asked).toEqual(["/api/jobs"]);
    // and the reader's own read of a script is not undone by a later poll seeing the same jobs
    await scriptsStore.loadScript(id, 1);
    await jobsStore.refresh();
    expect(scriptsStore._previous[`${id}:1`]).toBeUndefined();
  });

  test("a re-script keeps the previous script for the diff", async () => {
    const id = await shelved();
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await jobsStore.refresh();
    const first = scriptsStore.segmentsOf(id, 1);
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await jobsStore.refresh();
    expect(scriptsStore._previous[`${id}:1`]).toEqual(first);
  });

  test("chapters the server left out are said so, not waited for", async () => {
    const id = await shelved();
    await libraryStore.skipChapters(id, [2], true, { quiet: true });
    await scriptingStore._runRemote(id, [2]);
    expect(toasts.at(-1)?.msg).toBe("Nothing to script");
    expect(toasts.at(-1)?.kind).toBe("warn");
    expect(jobsStore.jobs).toEqual([]);
  });

  test("cancelling goes to the server, and the chapter follows", async () => {
    const gate = gatedProvider();
    wire({ scripting: gate.provider });
    const id = await shelved();
    await scriptingStore._runRemote(id, [1, 2], { quiet: true });
    await gate.started;
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
    jobsStore.stopPolling();
  });

  test("clearing the history and removing a job go through the server", async () => {
    const id = await shelved();
    await scriptingStore._runRemote(id, [1, 2], { quiet: true });
    await api.runner.idle();
    await jobsStore.refresh();
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
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await jobsStore.refresh();
    const had = jobsStore.jobs.length;
    setJobsService(new HttpJobsService("/api", () => Promise.reject(new Error("ECONNREFUSED"))));
    await jobsStore.refresh();
    expect(jobsStore.jobs).toHaveLength(had);
    expect(toasts.at(-1)?.msg).toBe("Could not reach the server");
  });
});
