import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { clone } from "@/lib/utils";

let restore: (() => void)[] = [];
beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
});
afterEach(() => restore.splice(0).forEach((fn) => fn()));

test("stores initialized in different orders share a coherent fixture world, not mutable seeds", () => {
  const first = createPinia();
  const endpoints = useEndpointsStore(first);
  const cast = useCastStore(first);
  const scripts = useScriptsStore(first);
  const library = useLibraryStore(first);
  const originalName = library.books[0].title;
  const originalText = scripts.segmentsOf("cliche", 1)[0].text;
  const voiceRef = cast.charactersOf("cliche")[0].voice;
  expect(endpoints.resolveVoice(voiceRef)).not.toBeNull();
  library.books[0].title = "Changed in first instance";
  scripts.segmentsOf("cliche", 1)[0].text = "Changed script";
  endpoints.endpoints[0].voices.splice(0);

  const second = createPinia();
  // Deliberately reverse the initialization order.
  const otherExports = useExportsStore(second);
  const otherLibrary = useLibraryStore(second);
  const otherScripts = useScriptsStore(second);
  const otherEndpoints = useEndpointsStore(second);
  expect(otherLibrary.books[0].title).toBe(originalName);
  expect(otherScripts.segmentsOf("cliche", 1)[0].text).toBe(originalText);
  expect(otherEndpoints.resolveVoice(voiceRef)).not.toBeNull();
  for (const item of otherExports.exports)
    for (const id of item.chapterIds) expect(otherLibrary.chapter(item.bookId, id)).toBeDefined();
  // Reset uses an untouched seed, not objects mutated through another live store.
  library.$reset();
  expect(library.books[0].title).toBe(originalName);
});

test("job numbering belongs to a session and stays unique after clearing history", () => {
  const first = useJobsStore(createPinia());
  const second = useJobsStore(createPinia());
  const a = first.addJob("scripting", "cliche", "A");
  const b = second.addJob("scripting", "cliche", "B");
  expect(a.id).toBe(b.id);
  first.jobs = [];
  expect(first.addJob("export", "cliche", "Next").id).toBeGreaterThan(a.id);
  expect(second.jobs.some((job) => job.label === "Next")).toBe(false);
});

test("a saved expression renderer keeps reading its own stores after another Pinia becomes active", () => {
  const first = createPinia();
  const narration = useNarrationStore(first);
  const segment = useScriptsStore(first).segmentsOf("cliche", 1)[0];
  const render = narration.expressionRender;
  const before = render("cliche", segment);
  const second = createPinia();
  const otherCast = useCastStore(second);
  otherCast.lexicon.cliche.push({
    id: 999,
    term: segment.text.split(" ")[0],
    say: "DIFFERENT",
    enabled: true,
    matchCase: false,
  });
  setActivePinia(second);
  expect(render("cliche", segment)).toEqual(before);
});

test("an asynchronous export settles only the stores that started it", async () => {
  let seq = 0;
  const callbacks = new Map<number, () => void>();
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
    callbacks.set(++seq, fn);
    return seq;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((id: number) =>
    callbacks.delete(id)) as typeof clearInterval);
  restore.push(
    () => timer.mockRestore(),
    () => clear.mockRestore(),
  );
  const first = createPinia();
  const exports = useExportsStore(first);
  useUiStore(first).toast = () => "test";
  const ids = useLibraryStore(first)
    .chaptersOf("starforge")
    .filter((c) => c.narration === "done")
    .slice(0, 2)
    .map((c) => c.id);
  const item = (await exports.buildExport("starforge", ids, {
    ...DEFAULT_EXPORT_SETTINGS,
    filename: "isolated run",
    title: "Isolated run",
  }))!;
  expect(item.status).toBe("building");
  const second = createPinia();
  const otherExports = useExportsStore(second);
  const otherJobs = useJobsStore(second);
  const before = clone(otherExports.exports);
  setActivePinia(second);
  for (let tick = 0; tick < 20 && callbacks.size; tick++) for (const fn of callbacks.values()) fn();
  expect(item.status).toBe("done");
  expect(useJobsStore(first).jobs.find((j) => j.id === item.jobId)?.status).toBe("done");
  expect(otherExports.exports).toEqual(before);
  expect(otherJobs.jobs.some((j) => j.exportRun?.exportId === item.id)).toBe(false);
});

test("book removal and its undo cover dictionary and saved script revisions as well as live segments", () => {
  const library = useLibraryStore();
  const scripts = useScriptsStore();
  const cast = useCastStore();
  const ui = useUiStore();
  scripts._previous["cliche:1"] = clone(scripts.segmentsOf("cliche", 1));
  const before = {
    book: clone(library.bookById("cliche")),
    segments: clone(scripts.segmentsOf("cliche", 1)),
    dictionary: clone(cast.lexiconOf("cliche")),
    previous: clone(scripts._previous["cliche:1"]),
  };
  let undo: (() => void) | undefined;
  ui.toast = (_message, options = {}) => {
    undo = options.undo ?? undefined;
    return "test";
  };
  library.removeBook("cliche");
  expect(library.bookById("cliche")).toBeUndefined();
  expect(cast.lexicon.cliche).toBeUndefined();
  expect(scripts._previous["cliche:1"]).toBeUndefined();
  undo!();
  expect(library.bookById("cliche")).toEqual(before.book);
  expect(scripts.segmentsOf("cliche", 1)).toEqual(before.segments);
  expect(cast.lexiconOf("cliche")).toEqual(before.dictionary);
  expect(scripts._previous["cliche:1"]).toEqual(before.previous);
});

test("automatic voice assignment previews the exact change and undoes it as one action", () => {
  const cast = useCastStore();
  const ui = useUiStore();
  const before = cast.charactersOf("starforge").map((c) => ({ name: c.name, voice: c.voice }));
  const plan = cast.autoAssignPlan("starforge");
  expect(plan.length).toBeGreaterThan(0);
  expect(plan.every((row) => row.name !== "Narrator" && row.voice.includes("/"))).toBe(true);

  let undo: (() => void) | undefined;
  ui.toast = (_message, options = {}) => {
    undo = options.undo ?? undefined;
    return "test";
  };
  expect(cast.autoAssignByGender("starforge")).toBe(plan.length);
  for (const row of plan)
    expect(cast.charactersOf("starforge").find((c) => c.name === row.name)?.voice).toBe(row.voice);
  for (const row of before.filter((c) => c.voice))
    expect(cast.charactersOf("starforge").find((c) => c.name === row.name)?.voice).toBe(row.voice);

  undo!();
  expect(cast.charactersOf("starforge").map((c) => ({ name: c.name, voice: c.voice }))).toEqual(
    before,
  );
});

test("a book remembers the chapter it is open on, and forgets one it no longer has", () => {
  const uiStore = useUiStore();
  const libraryStore = useLibraryStore();
  const chapters = libraryStore.chaptersOf("cliche");

  // nothing opened yet: every stage falls back to its own pick
  expect(uiStore.chapterIn("cliche", chapters)).toBeNull();

  uiStore.openChapter("cliche", chapters[2].id);
  expect(uiStore.chapterIn("cliche", chapters)).toBe(chapters[2].id);
  // one book's place is not another's
  expect(uiStore.chapterIn("drowned", libraryStore.chaptersOf("drowned"))).toBeNull();

  // a re-import can take the chapter away; the stages must not open a chapter that isn't there
  expect(
    uiStore.chapterIn(
      "cliche",
      chapters.filter((c) => c.id !== chapters[2].id),
    ),
  ).toBeNull();
});
