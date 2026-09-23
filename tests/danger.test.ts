import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";
// One rule for danger, and the point of having one: you never have to work out which kind of
// destructive control you are looking at.
//
// If it can be undone it happens at once and offers Undo; if it cannot, it asks first. So every
// removal below toasts with an undo and none of them asks, while discarding an import — the one
// thing no snapshot can put back — carries no undo, which is what earns it its confirmation step.
//
// The toast is what the confirmation step used to be, so it has to carry the same facts, including
// the one thing Undo does not return: runs that were still going.
import { test, expect, describe, beforeEach } from "bun:test";
import { testPinia } from "./support/pinia";

import type { Job, ToastOptions } from "@/types";

let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let uiStore: ReturnType<typeof useUiStore>;
/** Every toast raised since the last removal, newest last. */
let toasts: { message: string; options: ToastOptions }[];

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  // with the query cache installed, as removing a volume or a book invalidates what it read
  testPinia();
  castStore = useCastStore();
  endpointsStore = useEndpointsStore();
  exportsStore = useExportsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  uiStore = useUiStore();
  toasts = [];
  uiStore.toast = (message, options = {}) => {
    toasts.push({ message, options });
    return "test";
  };
});

const last = () => toasts.at(-1)!;
/** A run of this book that is still going — the state a removal cancels for good. */
function startJob(bookId: string, chapterId: number | null): Job {
  const job: Job = {
    id: 9001,
    kind: "narration",
    bookId,
    chapterId,
    label: "test run",
    status: "running",
    progress: 0.4,
    queuedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    cancelled: false,
  };
  jobsStore.jobs.push(job);
  return job;
}

describe("everything that can be undone acts at once", () => {
  test("each removal takes effect immediately and hands back the undo that reverses it", async () => {
    const removals: { what: string; run: () => void | Promise<unknown>; gone: () => boolean }[] = [
      {
        what: "a speaker",
        run: () => castStore.deleteCharacter("cliche", castStore.charactersOf("cliche")[1].name),
        gone: () => castStore.charactersOf("cliche").length === cast0 - 1,
      },
      {
        what: "a voice",
        run: () =>
          endpointsStore.removeVoice(
            endpointsStore.endpoints[0],
            endpointsStore.endpoints[0].voices[0].id,
          ),
        gone: () => endpointsStore.endpoints[0].voices.length === voices0 - 1,
      },
      {
        what: "an endpoint",
        run: () => endpointsStore.removeEndpoint(endpointsStore.endpoints[0].id),
        gone: () => endpointsStore.endpoints.length === endpoints0 - 1,
      },
      {
        what: "an audiobook",
        run: () => exportsStore.deleteExport(exportsStore.exports[0].id),
        gone: () => exportsStore.exports.length === exports0 - 1,
      },
      {
        what: "a volume",
        run: () =>
          libraryStore.removeVolume("cliche", libraryStore.bookById("cliche")!.volumes[0].id),
        gone: () => libraryStore.bookById("cliche")!.volumes.length === volumes0 - 1,
      },
      {
        what: "a novel",
        run: () => libraryStore.removeBook("cliche"),
        gone: () => libraryStore.bookById("cliche") === undefined,
      },
    ];
    const cast0 = castStore.charactersOf("cliche").length;
    const voices0 = endpointsStore.endpoints[0].voices.length;
    const endpoints0 = endpointsStore.endpoints.length;
    const exports0 = exportsStore.exports.length;
    const volumes0 = libraryStore.bookById("cliche")!.volumes.length;

    for (const r of removals) {
      toasts = [];
      await r.run();
      // it happened — nothing was staged behind a second click
      expect(r.gone(), `${r.what} is gone at once`).toBe(true);
      // and it is undoable, which is what lets it skip the question
      expect(last().options.undo, `${r.what} offers Undo`).toBeTypeOf("function");
      last().options.undo!();
      expect(r.gone(), `${r.what} came back`).toBe(false);
    }
  });

  test("discarding an import carries no undo, which is what earns it a question", async () => {
    const id = (await libraryStore.importBook({
      sample: "clean",
      id: "import-test",
      file: "x.epub",
    }))!;
    expect(libraryStore.bookById(id)?.importing).toBe(true);
    toasts = [];
    expect(await libraryStore.discardImport(id)).toBe("book");
    expect(libraryStore.bookById(id)).toBeUndefined();
    // nothing raised an undoable toast: the page asks first instead, and that is the whole rule
    expect(toasts.every((t) => !t.options.undo)).toBe(true);
  });
});

describe("the toast says what the question used to say", () => {
  test("removing a novel names it and how many chapters went with it", () => {
    const chapters = libraryStore.chaptersOf("cliche").length;
    libraryStore.removeBook("cliche");
    expect(last().message).toContain("The Cliché Cultivation World");
    expect(last().options.description).toContain(`${chapters} chapters`);
  });

  test("removing a volume says the rest were renumbered", () => {
    libraryStore.removeVolume("cliche", libraryStore.bookById("cliche")!.volumes[0].id);
    expect(last().options.description).toContain("renumbered");
  });

  // Undo is the one thing that cannot bring back a cancelled run, so the toast names one exactly
  // when the removal cancelled it — a run elsewhere in the book is not the volume's to mention
  const firstVolume = () => libraryStore.bookById("cliche")!.volumes[0].id;
  const chapterIn = (inFirst: boolean) =>
    libraryStore.chaptersOf("cliche").find((c) => (c.volumeId === firstVolume()) === inFirst)!.id;
  const removeBook = () => libraryStore.removeBook("cliche");
  const removeVolume = () => libraryStore.removeVolume("cliche", firstVolume());
  test.each([
    { case: "a novel", runAt: () => 1, remove: removeBook },
    { case: "a volume", runAt: () => chapterIn(true), remove: removeVolume },
  ])(
    "removing $case names the run it cancelled, which Undo cannot bring back",
    ({ runAt, remove }) => {
      jobsStore.jobs = [];
      startJob("cliche", runAt());
      remove();
      expect(last().options.description).toContain("1 run in flight was cancelled");
      expect(last().options.description).toContain("Undo");
      // and the undo really does leave it out, so the sentence is not decoration
      last().options.undo!();
      expect(jobsStore.jobs.some((j) => j.id === 9001)).toBe(false);
    },
  );

  test.each([
    { case: "a novel with nothing running", remove: removeBook, start: () => {} },
    {
      case: "a volume while a run goes elsewhere in the book",
      remove: removeVolume,
      start: () => startJob("cliche", chapterIn(false)),
    },
  ])("removing $case does not mention runs at all", ({ remove, start }) => {
    jobsStore.jobs = [];
    start();
    remove();
    expect(last().options.description).not.toContain("in flight");
  });
});
