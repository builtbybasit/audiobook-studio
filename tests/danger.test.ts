// One rule for danger, and the point of having one: you never have to work out which kind of
// destructive control you are looking at.
//
// If it can be undone it happens at once and offers Undo; if it cannot, it asks first. Removing a
// speaker, a voice or an endpoint toasts with an undo and none of them asks. Removing a novel or a
// volume, and discarding an import, are gone from the server for good — nothing puts a book back in
// the database — so their controls ask first, and the toast after says it cannot be undone rather
// than offering a button that would lie. The toast is what the confirmation step would have said,
// so it carries the same facts.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";
import type { ToastOptions } from "@/types";
import { demoServer, type DemoServer } from "./support/demoServer";
import { epubFile, story } from "./support/epub";
import { testPinia, type TestPinia } from "./support/pinia";

let demo: DemoServer;
let pinia: TestPinia;
let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
/** Every toast raised since the last removal, newest last. */
let toasts: { message: string; options: ToastOptions }[];

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  demo = await demoServer();
});
beforeEach(async () => {
  await demo.reset();
  // with the query cache installed, as removing a volume or a book invalidates what it read
  pinia = testPinia();
  castStore = useCastStore();
  endpointsStore = useEndpointsStore();
  libraryStore = useLibraryStore();
  toasts = [];
  useUiStore().toast = (message, options = {}) => {
    toasts.push({ message, options });
    return "test";
  };
  await Promise.all([libraryStore.loadBook("cliche"), endpointsStore.load()]);
  castStore._install("cliche", await libraryService().cast("cliche"));
});
afterEach(() => pinia.stop());

const last = () => toasts.at(-1)!;

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
    ];
    const cast0 = castStore.charactersOf("cliche").length;
    const voices0 = endpointsStore.endpoints[0].voices.length;
    const endpoints0 = endpointsStore.endpoints.length;

    for (const r of removals) {
      toasts = [];
      await r.run();
      // it happened — nothing was staged behind a second click
      expect(r.gone(), `${r.what} is gone at once`).toBe(true);
      // and it is undoable, which is what lets it skip the question
      expect(last().options.undo, `${r.what} offers Undo`).toBeTypeOf("function");
      await last().options.undo!();
      expect(r.gone(), `${r.what} came back`).toBe(false);
    }
  });
});

describe("what cannot be undone says so, and offers no Undo", () => {
  test("removing a novel names it and how many chapters went with it", async () => {
    const chapters = libraryStore.chaptersOf("cliche").length;
    await libraryStore.removeBook("cliche");
    expect(libraryStore.bookById("cliche")).toBeUndefined();
    expect(last().message).toContain("The Cliché Cultivation World");
    expect(last().options.description).toContain(`${chapters} chapters`);
    expect(last().options.description).toContain("cannot be undone");
    expect(last().options.undo).toBeFalsy();
  });

  test("removing a volume says the rest were renumbered", async () => {
    await libraryStore.removeVolume("cliche", libraryStore.bookById("cliche")!.volumes[0].id);
    expect(last().options.description).toContain("renumbered");
    expect(last().options.description).toContain("cannot be undone");
    expect(last().options.undo).toBeFalsy();
  });

  test("discarding an import raises nothing to undo", async () => {
    const source = await epubFile({ chapters: [{ title: "One", paragraphs: story(2) }] });
    const id = (await libraryStore.importBook({ source }))!;
    expect(libraryStore.bookById(id)?.importing).toBe(true);
    toasts = [];
    expect(await libraryStore.discardImport(id)).toBe("book");
    expect(libraryStore.bookById(id)).toBeUndefined();
    expect(toasts.every((t) => !t.options.undo)).toBe(true);
  });
});
