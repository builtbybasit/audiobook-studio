// `AudioFiles.find`: a clip's url back to its file on disk, and nothing else — not another book's,
// not a path that climbs out of the library, not a file that is not there.
import { describe, expect, test } from "bun:test";

import { audioFiles } from "~/audio/files";
import { tempAudioDir } from "../support/server";

describe("finding a clip's file by its url", () => {
  test("a url this library gave a book's clip, and only that", async () => {
    const files = audioFiles(tempAudioDir());
    const { url } = await files.write("book-a", new Uint8Array([1, 2, 3]), "wav");
    const file = url.split("/").at(-1)!;

    expect(await files.find(url)).toBe(files.path("book-a", file)!);
    expect(await files.find(url, "book-a")).toBe(files.path("book-a", file)!);
    // the same url asked for in another book
    expect(await files.find(url, "book-b")).toBeUndefined();
    // another library's base
    expect(await files.find(`/demo${url}`)).toBeUndefined();
    // a way out of the book's directory
    expect(await files.find(`/api/audio/book-a/../book-a/${file}`)).toBeUndefined();
    expect(await files.find(`/api/audio/../../${file}`)).toBeUndefined();
    // a name a clip could have, and no file behind it
    expect(await files.find(`/api/audio/book-a/${crypto.randomUUID()}.wav`)).toBeUndefined();
  });
});
