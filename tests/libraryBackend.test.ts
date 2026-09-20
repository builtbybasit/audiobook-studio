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

import { HttpLibraryService, setLibraryService } from "@/services/library";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { useChapterText, chapterTextNow } from "@/queries";
import { createApp } from "~/app";
import { openDb } from "~/db/client";
import { migrate } from "~/db/migrate";
import { epubFile, story } from "./support/epub";
import { flush, testPinia, type TestPinia } from "./support/pinia";
import { collectingLogger } from "./support/server";

let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let toasts: { msg: string; undo: (() => void) | null }[];
let pinia: TestPinia;
/** every path the store asked the server for, in order */
let asked: string[];

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
  asked = [];
  setLibraryService(
    new HttpLibraryService("/api", async (input, init) => {
      asked.push(input);
      return app.request(new Request(`http://api.test${input}`, init));
    }),
  );
  pinia = testPinia();
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
afterEach(() => {
  pinia.stop();
  setLibraryService(null);
});

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

  test("the shelf knows how many chapters a book has before the book is opened", async () => {
    const id = (await libraryStore.importBook({ source: await noted() }))!;
    await libraryStore.skipChapters(id, [2], true, { quiet: true });
    await libraryStore.confirmImport(id);
    // a reload: the shelf is listed, and no book has been opened
    pinia = testPinia();
    libraryStore = useLibraryStore();
    await libraryStore.load();
    expect(libraryStore.chaptersOf(id)).toEqual([]);
    expect(libraryStore.bookById(id)?.chapters).toEqual({
      total: 3,
      included: 2,
      scripted: 0,
      narrated: 0,
    });
    // what the shelf card reads: never "0 chapters" for a book that has three
    expect(libraryStore.contentsOf(id)).toMatchObject({ total: 3, included: 2, skipped: 1 });
    expect(libraryStore.progress(id)).toMatchObject({ total: 2, excluded: 1, scripted: 0 });
    // and once the book is opened, its chapters are what is counted
    await libraryStore.loadBook(id);
    expect(libraryStore.contentsOf(id)).toMatchObject({ total: 3, included: 2, suggested: 0 });
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
    // The store's synchronous readings resolve the query cache through the active pinia, which a
    // leftover task from an earlier test can point back at that test's; read them where the app
    // resolves it by injection, as a page would.
    const partsNow = () => pinia.run(() => scriptsStore.partsOf(id, 1));
    const rawNow = () => pinia.run(() => scriptsStore.rawText(id, 1));

    // before it is read, there is nothing — not seeded prose standing in for it
    expect(partsNow()).toEqual([]);
    expect(rawNow()).toBe("");

    const markdown = pinia.run(() => useChapterText(id, 1));
    // the read is a request and a store install; one tick is not always both
    for (let i = 0; i < 20 && markdown.status.value !== "success"; i++) await flush();
    expect(markdown.status.value).toBe("success");
    expect(markdown.text.value).toBeTruthy();
    expect(markdown.parts.value).toEqual([{ text: markdown.text.value }]);
    // the store's own readings now find it: the same text, from the same read
    expect(partsNow()).toEqual(markdown.parts.value);

    // anything that counts, bills or speaks a chapter reads the plain form, which is a separate ask
    expect(rawNow()).toBe("");
    const plain = pinia.run(() => useChapterText(id, 1, "plain"));
    for (let i = 0; i < 20 && plain.status.value !== "success"; i++) await flush();
    expect(rawNow()).toBe(plain.text.value);
    expect(pinia.run(() => chapterTextNow(id, 1, "plain"))).toBe(plain.text.value);
    expect(rawNow()).not.toContain("#");
  });

  test("is read once, and again only when the chapter numbers it was keyed by move", async () => {
    const id = (await libraryStore.importBook({ source: await volume(["One", "Two"]) }))!;
    await libraryStore.confirmImport(id);
    await libraryStore.importVolume(id, { source: await volume(["Three"]), name: "Vol. 2" });
    await libraryStore.confirmImport(id);
    const text = `/api/books/${id}/chapters/3/text?format=markdown`;
    const third = pinia.run(() => useChapterText(id, 3));
    await flush();
    expect(third.text.value).toBeTruthy();
    expect(asked.filter((p) => p === text)).toHaveLength(1);
    // a second page asking for the same chapter is answered from the cache
    const again = pinia.run(() => useChapterText(id, 3));
    await flush();
    expect(again.text.value).toBe(third.text.value);
    expect(asked.filter((p) => p === text)).toHaveLength(1);

    // removing the first volume renumbers what is left; chapter 3 is now chapter 1, and the text
    // read against the old number would be the wrong chapter's prose — so everything read about
    // the book is asked for again, and the old number is not a chapter any more
    await libraryStore.removeVolume(id, 1);
    await flush();
    await flush();
    expect(asked.filter((p) => p === text)).toHaveLength(2);
    expect(third.status.value).toBe("error");
    const first = pinia.run(() => useChapterText(id, 1));
    await flush();
    expect(first.text.value).toBe(third.text.value);
  });
});
