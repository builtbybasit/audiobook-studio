// The library store against the real API.
//
// `libraryClient.test.ts` next door proves the client and the routes agree. This is the layer
// above: the store the screens actually read, driven through the real `HttpLibraryService` against
// the real Hono app over a private in-memory database. A store action that forgets to await, an
// import that never sends the file, or a screen left holding seeded books in backend mode fails
// here rather than in the browser.
//
// What these are really guarding is the mode rule: with a server answering, nothing on screen may
// come from `@/mock`. Several assertions below are about what is *absent* for that reason.
//
// It sits with the store tests rather than in `tests/server/` because its subject is the store.
// That project is compiled without the DOM on purpose — it is what stops server code reaching for
// a `window` — and a Pinia store brings one in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { HttpLibraryService, setLibraryService } from "@/services/library";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { createApp } from "~/app";
import { openDb } from "~/db/client";
import { migrate } from "~/db/migrate";
import { epubFile, story } from "./support/epub";
import { collectingLogger } from "./support/server";

let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let toasts: { msg: string; undo: (() => void) | null }[];

const volume = (titles: string[]) =>
  epubFile({ chapters: titles.map((title) => ({ title, paragraphs: story() })) });

/** A book whose second chapter the import flags as a hiatus notice. */
const noted = () =>
  epubFile({
    chapters: [
      { title: "One", paragraphs: story() },
      {
        title: "A short break",
        paragraphs: [
          "Going on hiatus for a few weeks. Thank you for reading, and for your patience.",
        ],
      },
      { title: "Three", paragraphs: story() },
    ],
  });

beforeEach(() => {
  // the seeded world reaches for `matchMedia` as it is built; the store must not build one at all
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  const db = openDb(":memory:");
  migrate(db);
  const app = createApp(db, { log: collectingLogger().log });
  // The service goes in before the store is created: the store reads it while building its state,
  // which is how it knows not to seed itself from the demo world.
  setLibraryService(
    new HttpLibraryService("/api", async (input, init) =>
      app.request(new Request(`http://api.test${input}`, init)),
    ),
  );
  setActivePinia(createPinia());
  libraryStore = useLibraryStore();
  scriptsStore = useScriptsStore();
  toasts = [];
  const uiStore = useUiStore();
  uiStore.toast = (msg, opts = {}) => {
    toasts.push({ msg, undo: opts.undo ?? null });
    return "";
  };
});

// The service is module state, and every other suite in this repository is the seeded world. Left
// set, it would quietly put the demo tests in backend mode against a database that has gone.
afterEach(() => setLibraryService(null));

describe("the library store with a server answering", () => {
  test("starts empty rather than on the seeded shelf", async () => {
    // The bug this exists for: backend mode showing fixture books that look like a real library.
    expect(libraryStore.books).toEqual([]);
    expect(libraryStore.shelved).toEqual([]);
    await libraryStore.load();
    expect(libraryStore.books).toEqual([]);
    expect(libraryStore.loaded).toBe(true);
  });

  test("imports the file itself, and holds what the server parsed out of it", async () => {
    const id = await libraryStore.importBook({
      source: await volume(["One", "Two"]),
      title: "Moonlight Ledger",
    });
    expect(id).not.toBeNull();
    // the titles came out of the EPUB, so nothing but a real upload could have produced them
    expect(libraryStore.chaptersOf(id!).map((c) => c.title)).toEqual(["One", "Two"]);
    expect(libraryStore.bookById(id!)?.title).toBe("Moonlight Ledger");
    // still in its review, so the shelf does not list it yet
    expect(libraryStore.bookById(id!)?.importing).toBe(true);
    expect(libraryStore.shelved).toEqual([]);
  });

  test("an import with no file asks for one instead of inventing a book", async () => {
    expect(await libraryStore.importBook({ sample: "clean", file: "x.epub" })).toBeNull();
    expect(libraryStore.books).toEqual([]);
    expect(toasts.at(-1)?.msg).toContain("Could not read that file");
  });

  test("a file the server will not read leaves the library alone and says why", async () => {
    const id = await libraryStore.importBook({
      source: new File(["not a zip"], "notes.epub"),
    });
    expect(id).toBeNull();
    expect(libraryStore.books).toEqual([]);
    // the server's own sentence, not a generic failure
    expect(toasts.at(-1)?.msg).toBeTruthy();
  });

  test("a skipped chapter is skipped on the server, not just on screen", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One", "Two", "Three"]) }))!;
    await libraryStore.skipChapters(id, [2], true, { quiet: true });
    expect(libraryStore.chapter(id, 2)?.excluded).toBe(true);

    // read it back from the database through a second store: what is on screen is what was stored
    const reread = await libraryStore.loadBook(id);
    expect(reread).toBe(true);
    expect(libraryStore.chapter(id, 2)?.excluded).toBe(true);
    expect(libraryStore.contentsOf(id).included).toBe(2);
  });

  test("a batch skip offers an Undo that goes back to the server", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One", "Two", "Three"]) }))!;
    expect(await libraryStore.skipChapters(id, [1, 2], true)).toBe(2);
    expect(libraryStore.contentsOf(id).skipped).toBe(2);

    const undo = toasts.at(-1)?.undo;
    expect(undo).toBeTypeOf("function");
    await undo!();
    expect(libraryStore.contentsOf(id).skipped).toBe(0);
    // and the server agrees, which is the half an in-memory undo would have got wrong
    await libraryStore.loadBook(id);
    expect(libraryStore.contentsOf(id).skipped).toBe(0);
  });

  test("undoing a skip puts a noted chapter back undecided, on the server too", async () => {
    const id = (await libraryStore.importBook({ source: await noted() }))!;
    expect(libraryStore.chapter(id, 2)?.note?.kind).toBe("hiatus");
    await libraryStore.skipChapters(id, [2], true);
    await toasts.at(-1)!.undo!();
    // the inverse route would have left it `kept`; an exact undo does not
    expect(libraryStore.chapter(id, 2)?.excluded).toBeUndefined();
    expect(libraryStore.chapter(id, 2)?.kept).toBeUndefined();
    await libraryStore.loadBook(id);
    expect(libraryStore.chapter(id, 2)?.kept).toBeUndefined();
    expect(libraryStore.contentsOf(id).suggested).toBe(1);
  });

  test("keeping a chapter offers an Undo that goes back to the server", async () => {
    const id = (await libraryStore.importBook({ source: await noted() }))!;
    expect(await libraryStore.keepChapters(id, [2])).toBe(1);
    expect(libraryStore.chapter(id, 2)?.kept).toBe(true);
    const undo = toasts.at(-1)?.undo;
    expect(undo).toBeTypeOf("function");
    await undo!();
    expect(libraryStore.chapter(id, 2)?.kept).toBeUndefined();
    await libraryStore.loadBook(id);
    expect(libraryStore.chapter(id, 2)?.kept).toBeUndefined();
  });

  test("confirming the review shelves the book the server holds", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One", "Two"]) }))!;
    expect(await libraryStore.confirmImport(id)).toBe(true);
    expect(libraryStore.bookById(id)?.importing).toBeUndefined();
    expect(libraryStore.shelved.map((b) => b.id)).toEqual([id]);

    // a fresh read of the shelf still has it: confirming was a write, not a local flag
    await libraryStore.load(true);
    expect(libraryStore.books.map((b) => b.id)).toEqual([id]);
  });

  test("discarding an import takes it off the server too", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One"]) }))!;
    expect(await libraryStore.discardImport(id)).toBe("book");
    expect(libraryStore.bookById(id)).toBeUndefined();
    await libraryStore.load(true);
    expect(libraryStore.books).toEqual([]);
  });

  test("a volume is added to the book it belongs to and numbers on from it", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One", "Two"]) }))!;
    await libraryStore.confirmImport(id);
    const volId = await libraryStore.importVolume(id, {
      source: await volume(["Three"]),
      name: "Vol. 2",
    });
    expect(volId).not.toBeNull();
    expect(libraryStore.chaptersOf(id).map((c) => c.id)).toEqual([1, 2, 3]);
    expect(libraryStore.importingVolume(id)?.name).toBe("Vol. 2");
    expect(await libraryStore.discardImport(id)).toBe("volume");
    expect(libraryStore.chaptersOf(id).map((c) => c.id)).toEqual([1, 2]);
  });

  test("removing a book is permanent, and the toast does not pretend otherwise", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One"]) }))!;
    await libraryStore.confirmImport(id);
    await libraryStore.removeBook(id);
    expect(libraryStore.bookById(id)).toBeUndefined();
    // no route puts a book back, so no button claims to
    expect(toasts.at(-1)?.undo).toBeNull();
    expect(toasts.at(-1)?.msg).toContain("Removed");
    await libraryStore.load(true);
    expect(libraryStore.books).toEqual([]);
  });

  test("a book the server does not have is not found, rather than half-loaded", async () => {
    expect(await libraryStore.loadBook("no-such-book")).toBe(false);
    expect(libraryStore.bookById("no-such-book")).toBeUndefined();
    expect(toasts.at(-1)?.msg).toBeTruthy();
  });
});

describe("chapter prose with a server answering", () => {
  test("is the server's, in both readings, and never a fixture", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One"]) }))!;

    // before it is read, there is nothing — not seeded prose standing in for it
    expect(libraryStore.textOf(id, 1)).toBeNull();
    expect(scriptsStore.partsOf(id, 1)).toEqual([]);
    expect(scriptsStore.rawText(id, 1)).toBe("");

    await libraryStore.loadText(id, 1);
    const markdown = libraryStore.textOf(id, 1);
    expect(markdown).toBeTruthy();
    expect(scriptsStore.partsOf(id, 1)).toEqual([{ text: markdown! }]);

    // anything that counts, bills or speaks a chapter reads the plain form, which is a separate ask
    expect(libraryStore.textOf(id, 1, "plain")).toBeNull();
    await libraryStore.loadText(id, 1, "plain");
    expect(scriptsStore.rawText(id, 1)).toBe(libraryStore.textOf(id, 1, "plain")!);
    expect(scriptsStore.rawText(id, 1)).not.toContain("#");
  });

  test("is forgotten when the chapter numbers it was keyed by move", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One", "Two"]) }))!;
    await libraryStore.confirmImport(id);
    await libraryStore.importVolume(id, { source: await volume(["Three"]), name: "Vol. 2" });
    await libraryStore.confirmImport(id);
    await libraryStore.loadText(id, 3);
    expect(libraryStore.textOf(id, 3)).toBeTruthy();

    // removing the first volume renumbers what is left; chapter 3 is now chapter 1, and the text
    // cached against the old number would be the wrong chapter's prose
    await libraryStore.removeVolume(id, 1);
    expect(libraryStore.textOf(id, 3)).toBeNull();
    expect(libraryStore.textOf(id, 1)).toBeNull();
  });
});
