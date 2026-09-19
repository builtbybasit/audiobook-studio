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
import { createPinia, setActivePinia } from "pinia";

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
  setActivePinia(createPinia());
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
  test("each removal takes effect immediately and hands back the undo that reverses it", () => {
    const removals: { what: string; run: () => void; gone: () => boolean }[] = [
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
      r.run();
      // it happened — nothing was staged behind a second click
      expect(r.gone(), `${r.what} is gone at once`).toBe(true);
      // and it is undoable, which is what lets it skip the question
      expect(last().options.undo, `${r.what} offers Undo`).toBeTypeOf("function");
      last().options.undo!();
      expect(r.gone(), `${r.what} came back`).toBe(false);
    }
  });

  test("discarding an import carries no undo, which is what earns it a question", () => {
    const id = libraryStore.importBook("clean", { id: "import-test", file: "x.epub" });
    expect(libraryStore.bookById(id)?.importing).toBe(true);
    toasts = [];
    expect(libraryStore.discardImport(id)).toBe("book");
    expect(libraryStore.bookById(id)).toBeUndefined();
    // nothing raised an undoable toast: the page asks first instead, and that is the whole rule
    expect(toasts.every((t) => !t.options.undo)).toBe(true);
  });
});

describe("the toast says what the question used to say", () => {
  test("removing a novel names what went with it", () => {
    const chapters = libraryStore.chaptersOf("cliche").length;
    libraryStore.removeBook("cliche");
    expect(last().message).toContain("The Cliché Cultivation World");
    expect(last().options.description).toContain(`${chapters} chapters`);
    expect(last().options.description).toContain("script, cast and audiobooks");
  });

  test("removing a volume says the rest were renumbered", () => {
    libraryStore.removeVolume("cliche", libraryStore.bookById("cliche")!.volumes[0].id);
    expect(last().options.description).toContain("renumbered");
  });

  test("a run still going is named, because Undo is the one thing that cannot bring it back", () => {
    startJob("cliche", 1);
    libraryStore.removeBook("cliche");
    expect(last().options.description).toContain("1 run in flight was cancelled");
    expect(last().options.description).toContain("does not come back with Undo");
    // and the undo really does leave it out, so the sentence is not decoration
    last().options.undo!();
    expect(jobsStore.jobs.some((j) => j.id === 9001)).toBe(false);
  });

  test("with nothing running, the toast does not mention runs at all", () => {
    for (const j of jobsStore.jobs) if (!j.finishedAt) j.status = "done";
    libraryStore.removeBook("cliche");
    expect(last().options.description).not.toContain("in flight");
  });

  test("removing a volume names the runs inside it, which Undo cannot bring back", () => {
    const book = libraryStore.bookById("cliche")!;
    const inside = libraryStore
      .chaptersOf("cliche")
      .find((c) => c.volumeId === book.volumes[0].id)!;
    for (const j of jobsStore.jobs) if (!j.finishedAt) j.status = "done";
    startJob("cliche", inside.id);
    libraryStore.removeVolume("cliche", book.volumes[0].id);
    expect(last().options.description).toContain("1 run in flight was cancelled");
    expect(last().options.description).toContain("does not come back with Undo");
    // and the undo really does leave it out, so the sentence is not decoration
    last().options.undo!();
    expect(jobsStore.jobs.some((j) => j.id === 9001)).toBe(false);
  });

  test("only the volume's own runs are counted, not the rest of the book's", () => {
    const book = libraryStore.bookById("cliche")!;
    const elsewhere = libraryStore
      .chaptersOf("cliche")
      .find((c) => c.volumeId !== book.volumes[0].id)!;
    for (const j of jobsStore.jobs) if (!j.finishedAt) j.status = "done";
    startJob("cliche", elsewhere.id);
    libraryStore.removeVolume("cliche", book.volumes[0].id);
    expect(last().options.description).not.toContain("in flight");
  });
});
