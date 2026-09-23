// A book's id is a directory name, and its files are removed without anyone waiting.
//
// Two ways a book's files used to go wrong. A title with a letter outside ASCII gave the book an
// id the file modules refuse, so its audio was written and could never be fetched or removed. And
// a removal that failed on disk rejected with nobody listening, which Bun answers by exiting.
import { describe, expect, test } from "bun:test";

import { createApp } from "~/app";
import type { AudioFiles } from "~/audio/files";
import { audiobookFiles } from "~/exports/files";
import type { AudiobookFiles } from "~/exports/files";
import { slugify } from "~/lib/http";
import { wavEncoders } from "~/providers/wavEncoder";
import { epubFile, story } from "../support/epub";
import { collectingLogger, tempExportDir, testApi, testDb, testRunner } from "../support/server";

const book = () => epubFile({ chapters: [{ title: "One", paragraphs: story() }] });

describe("a book's id", () => {
  test("is ASCII, spelled the way English spells a title it has borrowed", () => {
    expect(slugify("Pokémon Red")).toBe("pokemon-red");
    expect(slugify("Encyclopædia Britannica")).toBe("encyclopaedia-britannica");
    expect(slugify("Straße der Ølfabrik")).toBe("strasse-der-olfabrik");
    expect(slugify("Łódź Nights")).toBe("lodz-nights");
    expect(slugify("The Philosopher’s Stone — Part 1")).toBe("the-philosophers-stone-part-1");
    expect(slugify("Ender's Game.epub")).toBe("enders-game");
    // Nothing ASCII in it at all: a book, which the library numbers if there is one already.
    expect(slugify("三体")).toBe("book");
  });

  test("is one the audio of the book can be written under, fetched by and removed with", async () => {
    const api = testApi();
    const { body } = await api.import<{ book: { id: string } }>(await book(), {
      title: "Straße",
    });
    expect(body.book.id).toBe("strasse");

    const { url } = await api.files.write(body.book.id, new Uint8Array([1, 2, 3]), "wav");
    const res = await api.fetch(url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("removing a book whose files will not go", () => {
  /** Files that write nowhere and fail every removal, the way a locked directory does. */
  function stubbornFiles(): { files: AudioFiles; built: AudiobookFiles; tried: string[] } {
    const tried: string[] = [];
    const refuse = (what: string) => {
      tried.push(what);
      return Promise.reject(
        Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
      );
    };
    const built = audiobookFiles(tempExportDir());
    return {
      tried,
      files: {
        dir: "/nowhere",
        write: async () => ({ url: "/api/audio/x/y.wav" }),
        path: () => null,
        remove: () => refuse("some clips"),
        removeBook: () => refuse("clips"),
      },
      built: { ...built, removeBook: () => refuse("audiobooks"), remove: () => refuse("export") },
    };
  }

  test("still removes the book, and the server is still there to say so", async () => {
    const db = testDb();
    const { log } = collectingLogger();
    const { files, built, tried } = stubbornFiles();
    const app = createApp(db, {
      log,
      files,
      runner: testRunner(db, log),
      exports: { encoders: wavEncoders(), files: built },
    });
    const form = new FormData();
    form.set("file", await book());
    const imported = await app.request("http://api.test/api/books/import", {
      method: "POST",
      body: form,
    });
    const { book: added } = (await imported.json()) as { book: { id: string } };

    const res = await app.request(`http://api.test/api/books/${added.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    // Let the removals run and fail. Before, each failure was an unhandled rejection, which ends a
    // Bun process and fails this test.
    await new Promise((r) => setTimeout(r, 20));
    expect(tried.sort()).toEqual(["audiobooks", "clips"]);

    const after = await app.request("http://api.test/api/books");
    expect(((await after.json()) as { books: unknown[] }).books).toEqual([]);
  });
});
