import { useCastStore } from "../src/stores/cast";
import { useEndpointsStore } from "../src/stores/endpoints";
import { useJobsStore } from "../src/stores/jobs";
import { useLibraryStore } from "../src/stores/library";
import { useNarrationStore } from "../src/stores/narration";
import { useScriptsStore } from "../src/stores/scripts";
import { useUiStore } from "../src/stores/ui";
// Pause and Cancel are different things, and the dispatcher has to agree with the words the
// Endpoints page puts on the buttons: pausing holds the queue, cancelling empties it.
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

let now = 1000;
let timers = new Map<number, { at: number; fn: () => void }>();
let seq = 0;
let restore: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;

/** Run every timer due inside the next `ms`, in time order. */
function advance(ms: number) {
  const target = now + ms;
  for (let guard = 0; guard < 50_000; guard++) {
    let nextId: number | null = null;
    let nextAt = Infinity;
    for (const [id, t] of timers)
      if (t.at < nextAt) {
        nextAt = t.at;
        nextId = id;
      }
    if (nextId === null || nextAt > target) break;
    now = nextAt;
    const t = timers.get(nextId)!;
    timers.delete(nextId);
    t.fn();
  }
  now = target;
}

const chapterId = 1;
const bookId = "cliche";

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  endpointsStore = useEndpointsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  jobsStore.jobs = [];
  uiStore.toast = () => "test";
  now = 1000;
  seq = 0;
  timers = new Map();
  restore = [
    spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms = 0) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    }) as unknown as typeof setTimeout),
    spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout),
    spyOn(Date, "now").mockImplementation(() => now),
    // no failures, no rate limits, deterministic latency
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());

  // route every speaker at the one local endpoint so the test is about that endpoint alone
  const local = endpointsStore.endpoints.find((e) => e.id === "local")!;
  local.enabled = true;
  local.backoffUntil = 0;
  for (const c of castStore.characters[bookId]) c.voice = `local/${local.voices[0].id}`;
});
afterEach(() => restore.forEach((fn) => fn()));

const statuses = () => scriptsStore.segmentsOf(bookId, chapterId).map((s) => s.audio.status);
const job = () => jobsStore.jobs.find((j) => j.kind === "narration" && j.chapterId === chapterId);

test("pausing an endpoint holds its queue; the run finishes when it is resumed", () => {
  const local = endpointsStore.endpoints.find((e) => e.id === "local")!;
  narrationStore.runNarration(bookId, [chapterId]);
  advance(3000);
  expect(job()).toBeDefined();
  expect(statuses().some((s) => s === "done" || s === "generating")).toBe(true);
  const doneWhilePaused = statuses().filter((s) => s === "done").length;
  expect(statuses().some((s) => s === "queued")).toBe(true);

  // pause: in-flight requests land, queued ones wait — the job stays open
  local.enabled = false;
  advance(60_000);
  expect(job()!.finishedAt).toBeNull();
  expect(libraryStore.chapter(bookId, chapterId)!.narration).toBe("running");
  expect(statuses().some((s) => s === "queued")).toBe(true);
  expect(statuses().some((s) => s === "generating")).toBe(false);
  // work that was already in flight when we paused was allowed to finish
  expect(statuses().filter((s) => s === "done").length).toBeGreaterThanOrEqual(doneWhilePaused);
  // nothing was failed just because the endpoint is paused
  expect(statuses().some((s) => s === "failed")).toBe(false);

  local.enabled = true;
  advance(600_000);
  expect(job()!.finishedAt).not.toBeNull();
  expect(statuses().every((s) => s === "done")).toBe(true);
});

test("cancelling empties the queue instead of holding it", () => {
  narrationStore.runNarration(bookId, [chapterId]);
  advance(3000);
  const id = job()!.id;
  jobsStore.cancelJob(id);
  advance(60_000);
  expect(job()!.finishedAt).not.toBeNull();
  expect(job()!.status).toBe("cancelled");
  expect(statuses().some((s) => s === "queued")).toBe(false);
});

test("a voice whose endpoint is gone still fails rather than waiting forever", () => {
  // removing the endpoint leaves the speakers pointing at nothing — unlike a pause, that can
  // never resolve on its own, so the run has to end
  narrationStore.runNarration(bookId, [chapterId]);
  advance(1000);
  endpointsStore.endpoints.splice(0, endpointsStore.endpoints.length);
  advance(120_000);
  expect(job()!.finishedAt).not.toBeNull();
  expect(libraryStore.chapter(bookId, chapterId)!.narration).toBe("failed");
  expect(job()!.activity!.some((e) => e.level === "error" && e.detail?.segment)).toBe(true);
  expect(job()!.activity!.at(-1)!.message).toBe("Job failed");
});

test("narration activity keeps the segment identity and attempt across a rate-limit retry", () => {
  narrationStore.runNarration(bookId, [chapterId]);
  spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.5);
  advance(600_000);
  const events = job()!.activity!;
  const limited = events.find((e) => e.detail?.code === 429)!;
  expect(limited).toBeDefined();
  expect(
    events.some(
      (e) =>
        e.detail?.segment === limited.detail?.segment &&
        e.detail?.attempt === 2 &&
        e.message.endsWith("completed"),
    ),
  ).toBe(true);
  expect(events.at(-1)!.message).toBe("Job done");
});
