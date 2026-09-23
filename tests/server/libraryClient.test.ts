// The client and the server, against each other.
//
// Both sides of the seam are in this repository, so "the API returns what the client reads" is
// something the suite can actually check rather than a comment two files apart. These drive the
// real `HttpLibraryService` against the real Hono app, so a route that renames a field fails here
// rather than in the browser.
import { describe, expect, test } from "bun:test";

import { HttpLibraryService, ApiError } from "@/services/library";
import { createApp } from "~/app";
import { openDb } from "~/db/client";
import { migrate } from "~/db/migrate";
import { epubFile, story } from "../support/epub";
import { collectingLogger } from "../support/server";

/** The client, wired to an in-memory server instead of the network. */
function client(): HttpLibraryService {
  const db = openDb(":memory:");
  migrate(db);
  const app = createApp(db, { log: collectingLogger().log });
  return new HttpLibraryService("/api", async (input, init) =>
    app.request(new Request(`http://api.test${input}`, init)),
  );
}

const volume = (titles: string[]) =>
  epubFile({ chapters: titles.map((title) => ({ title, paragraphs: story() })) });

describe("the library client against the real API", () => {
  test("imports a book and reads back what it imported", async () => {
    const api = client();
    const { book, chapters } = await api.importBook(await volume(["One", "Two"]), {
      title: "Moonlight Ledger",
    });
    expect(book.title).toBe("Moonlight Ledger");
    expect(chapters.map((c) => c.title)).toEqual(["One", "Two"]);

    const again = await api.book(book.id);
    expect(again.book).toEqual(book);
    expect(again.chapters).toEqual(chapters);
  });

  test("walks import → review → add", async () => {
    const api = client();
    const { book } = await api.importBook(await volume(["One", "Two", "Three"]));
    expect(book.importing).toBe(true);

    const skipped = await api.skipChapters(book.id, [2], true);
    expect(skipped[1].excluded).toBe(true);

    const shelved = await api.confirmImport(book.id);
    expect(shelved.importing).toBeUndefined();
    expect((await api.books()).map((b) => b.id)).toEqual([book.id]);
  });

  test("reads a chapter's text", async () => {
    const api = client();
    const { book } = await api.importBook(
      await epubFile({ chapters: [{ title: "One", paragraphs: ["Rain fell."] }] }),
    );
    expect(await api.chapterText(book.id, 1)).toContain("Rain fell.");
  });

  test("removing the only volume removes the book, and says which it did", async () => {
    // The store never asks the server this — it removes a one-volume book as a book — so the
    // client's reading of the answer is checked here or nowhere. (A volume added and discarded is
    // driven through this client by libraryBackend.test.ts.)
    const api = client();
    const { book } = await api.importBook(await volume(["One"]));
    await api.confirmImport(book.id);
    expect(await api.removeVolume(book.id, 1)).toBe("book");
    expect(await api.books()).toEqual([]);
  });

  test("an API error arrives as a message the UI can show", async () => {
    const api = client();
    const failed = await api
      .importBook(new File(["not a zip"], "notes.epub"))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ApiError);
    const err = failed as ApiError;
    expect(err.status).toBe(415);
    expect(err.message).toBe("That file could not be read as an EPUB");
    // the longer explanation is kept separately, for a panel to expand to
    expect(err.detail?.length).toBeGreaterThan(0);
  });

  test("a refused request arrives with the field the server complained about", async () => {
    const api = client();
    const { book } = await api.importBook(await volume(["One", "Two"]));
    const failed = await api
      .skipChapters(book.id, [], true)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ApiError);
    // Before, the server answered a bad body in the validator's shape and this could only ever
    // read "Request failed (400)" — a worse message than the one the server already had.
    expect((failed as ApiError).message).not.toContain("Request failed");
    expect((failed as ApiError).status).toBe(400);
  });

  test("something other than the API answering is an error the UI can show, not a SyntaxError", async () => {
    // A proxy, a dev server or a gateway in front of the API answers with HTML. Parsing it would
    // throw out of a method whose whole contract is that it throws `ApiError`.
    const proxied = new HttpLibraryService("/api", () =>
      Promise.resolve(
        new Response("<!doctype html><title>502 Bad Gateway</title>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const failed = await proxied
      .books()
      .then(() => null)
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).status).toBe(502);
    expect((failed as ApiError).detail).toContain("Bad Gateway");
  });

  test("a 200 that is not JSON is refused rather than handed on as a book list", async () => {
    const html = new HttpLibraryService("/api", () =>
      Promise.resolve(new Response("<html>login</html>", { status: 200 })),
    );
    const failed = await html
      .books()
      .then(() => null)
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).message).toBe("The server did not answer with JSON");
  });

  test("a server that cannot be reached says so, rather than looking like an empty library", async () => {
    const offline = new HttpLibraryService("/api", () => Promise.reject(new Error("ECONNREFUSED")));
    const failed = await offline
      .books()
      .then(() => null)
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).message).toBe("Could not reach the server");
    expect((failed as ApiError).status).toBe(0);
  });
});
