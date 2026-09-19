// The jobs, scripting, scripts, cast and history stores against the real API.
//
// `libraryBackend.test.ts` next door proves the library store's backend half. This is the rest:
// the stores the Queue, Scripting and Cast pages read, driven through the real `HttpJobsService`
// and `HttpLibraryService` against the real Hono app, the real runner and a fake scripting model,
// over a private in-memory database. The pages read through the query composables in
// `src/queries/`, so the tests do too: the queue is read the way the shell reads it, and a
// chapter's script, history and cast the way the Scripting and Cast pages open them.
//
// What these guard is the mode rule — with a server answering, no job, script, speaker or version
// on screen may come from `@/mock` — and that what the screens show is what the server holds, not
// what the store assumed when it sent the request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Segment } from "@/types";
import { key } from "@/lib/scriptReview";
import { useBookJobs, useCast, useChapterHistory, useChapterScript } from "@/queries";
import { HttpJobsService, setJobsService } from "@/services/jobs";
import { activeLibraryService, HttpLibraryService, setLibraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { readScript, writeScript } from "~/db/script";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import { epubFile, story } from "./support/epub";
import { flush, testPinia, type TestPinia } from "./support/pinia";
import { gatedProvider, testApi, type TestApi } from "./support/server";

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
        ...story(),
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

function wire(options: Parameters<typeof testApi>[0] = {}) {
  api = testApi(options);
  wireStores();
}

/** Fresh stores over the same server, as a reload would give. */
function wireStores() {
  // the seeded world reaches for `matchMedia` as it is built; the stores must not build one at all
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
  // its state, which is how it knows not to seed itself from the demo world.
  setLibraryService(new HttpLibraryService("/api", fetch));
  setJobsService(new HttpJobsService("/api", fetch));
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
  await scriptingStore._runRemote(id, [1], { quiet: true });
  await api.runner.idle();
  await poll();
  return { id, script, history, cast };
}

beforeEach(() => wire());

// The services are module state, and every other suite in this repository is the seeded world.
afterEach(() => {
  pinia.stop();
  setLibraryService(null);
  setJobsService(null);
});

describe("the queue with a server answering", () => {
  test("starts empty rather than on the seeded history", async () => {
    expect(jobsStore.jobs).toEqual([]);
    await poll();
    expect(jobsStore.jobs).toEqual([]);
    expect(queue.status.value).toBe("success");
    // and so do the other stores: a real library has no seeded scripts, cast or history
    expect(Object.keys(scriptsStore.segments)).toEqual([]);
    expect(Object.keys(castStore.characters)).toEqual([]);
    expect(Object.keys(historyStore.chapters)).toEqual([]);
  });

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
    // nothing here came from the simulator: the chapters were marked by the server's answer
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
    // the fake model's attribution, which nothing in the seeded world produces
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
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    expect(history.versions.value.map((v) => v.origin.kind)).toEqual(["edited", "scripted"]);
    expect(history.versions.value[0].segments[0].text).toBe("By hand.");
    expect(historyStore.headOf(id, 1).origin).toMatchObject({ kind: "scripted", again: true });
  });

  test("opening a scripted chapter reads its script once", async () => {
    const id = await shelved();
    await scriptingStore._runRemote(id, [1], { quiet: true });
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
    await scriptingStore._runRemote(id, [1, 2], { quiet: true });
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
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    expect(scriptsStore._previous[key(id, 1)]).toEqual(first);
    expect(scriptsStore._revision[key(id, 1)]).toBe(2);
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

  test("clearing the history and removing a job go through the server", async () => {
    const id = await shelved();
    await scriptingStore._runRemote(id, [1, 2], { quiet: true });
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
    await scriptingStore._runRemote(id, [1], { quiet: true });
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
    // another tab writes the chapter underneath this one
    const elsewhere: Segment[] = [
      {
        id: 1,
        type: "narration",
        speaker: "Narrator",
        text: "Written elsewhere.",
        direction: "",
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      },
    ];
    writeScript(api.db, id, 1, elsewhere);
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
    await scriptingStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    // the script was read once, by a page since closed: the store keeps the copy, the query
    // cache has nothing left to refetch
    scriptsStore._install(id, 1, await activeLibraryService()!.chapterScript(id, 1));
    const elsewhere: Segment[] = [
      {
        id: 1,
        type: "narration",
        speaker: "Narrator",
        text: "Written elsewhere.",
        direction: "",
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      },
    ];
    writeScript(api.db, id, 1, elsewhere);
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
    await scriptingStore._runRemote(id, [1], { quiet: true });
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

  test("a flag is written with its script, and adds nothing to the history", async () => {
    const { id, history } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    const line = scriptsStore.segmentsOf(id, 1)[0];
    narrationStore.flagSegment(id, 1, line.id, "delivery", "softer");
    await scriptsStore._settled(id, 1);
    expect(readScript(api.db, id, 1)[0].flag).toMatchObject({ kind: "delivery", note: "softer" });
    expect(scriptsStore._revision[key(id, 1)]).toBe(2);
    expect(history.versions.value).toEqual([]);
    expect(history.head.value.origin.kind).toBe("scripted");
    narrationStore.clearFlag(id, 1, line.id);
    await scriptsStore._settled(id, 1);
    expect(readScript(api.db, id, 1)[0].flag).toBeUndefined();
    expect(history.head.value.origin.kind).toBe("scripted");
    // a flag batch is a plain write too: it does not name itself as a bulk correction
    sent.length = 0;
    scriptsStore.applyBulk(id, [{ chId: 1, segId: line.id }], {
      kind: "flag",
      flag: "pause",
      note: "",
      replace: true,
    });
    await scriptsStore._settled(id, 1);
    const write = sent.find((r) => r.path.endsWith("/chapters/1/script"))!;
    expect(write.body).not.toHaveProperty("origin");
    expect(readScript(api.db, id, 1)[0].flag).toMatchObject({ kind: "pause" });
    expect(history.head.value.origin.kind).toBe("scripted");
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
    await toasts.find((t) => t.msg.startsWith("Chapter 1 restored"))!.undo!();
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
    expect(["queued", "running"]).toContain(libraryStore.chapter(id, 1)?.narration);
    await api.runner.idle();
    await poll();
    const segs = scriptsStore.segmentsOf(id, 1);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) {
      expect(s.audio.status).toBe("done");
      expect(s.audio.duration).toBeGreaterThan(0);
      expect(s.audio.url).toStartWith(`/api/audio/${id}/`);
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

  test("re-narrating what changed renders only those lines, and keeps the rest", async () => {
    const { id } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    await narrationStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
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

  test("a failed line is retried at the failed scope, and a retake is said to be unavailable", async () => {
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
    const { id } = await scriptedAndOpen();
    const narrationStore = useNarrationStore();
    await narrationStore._runRemote(id, [1], { quiet: true });
    await api.runner.idle();
    await poll();
    const broken = scriptsStore.segmentsOf(id, 1).find((s) => s.text.includes("count it twice"))!;
    expect(broken.audio.status).toBe("failed");
    expect(broken.audio.error?.message).toContain("dropped");
    expect(scriptsStore.segmentsOf(id, 1).filter((s) => s.audio.status === "done").length).toBe(
      scriptsStore.segmentsOf(id, 1).length - 1,
    );
    expect(libraryStore.chapter(id, 1)?.narration).toBe("failed");
    expect(jobsStore.jobs.find((j) => j.kind === "narration")?.status).toBe("failed");
    // one line, retried by hand: the server re-renders the chapter's failed lines
    narrationStore.retrySegment(id, 1, broken.id);
    await settle();
    await api.runner.idle();
    await poll();
    expect(scriptsStore.segmentsOf(id, 1).every((s) => s.audio.status === "done")).toBe(true);
    expect(libraryStore.chapter(id, 1)?.narration).toBe("done");
    // a retake is a verdict the server has no route for yet
    narrationStore.retakeSegment(id, 1, broken.id);
    expect(toasts.at(-1)?.msg).toBe("Retakes are not available with a server yet");
    expect(
      scriptsStore.segmentsOf(id, 1).find((s) => s.id === broken.id)?.candidate,
    ).toBeUndefined();
  });
});

describe("the audiobooks with a server answering", () => {
  test("are the server's, which has none yet, and a deletion would ask first", async () => {
    const id = await shelved();
    const exportsStore = useExportsStore();
    expect(exportsStore.exports).toEqual([]);
    expect(exportsStore.asksFirst).toBe(true);
    const { useBookExports } = await import("@/queries");
    const exports = pinia.run(() => useBookExports(id));
    await settle();
    expect(exports.status.value).toBe("success");
    expect(exports.exports.value).toEqual([]);
  });
});
