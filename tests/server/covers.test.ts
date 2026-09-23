// A cover image: kept from the EPUB, chosen for an audiobook, and written into the file — with
// the book's title, author and narrator beside it, which go into the file the same way.
//
// Until this slice a book's cover was two colours, and the Export page's picture travelled inside
// the build's JSON as a data URL that nothing ever wrote anywhere. Here the EPUB's own cover is
// kept when the book is imported, an image chosen for an audiobook is uploaded and named by the
// address it was given, and a build hands whichever applies to the encoder. The ffmpeg half is
// read back out of the file it wrote, with ffprobe, because "embedded" is a claim about bytes. So
// are the tags: the Export page has asked for a title, an author and a narrator since it was
// drawn, and until this slice they were kept on the export's row and written nowhere.
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Book, ExportItem, ExportSettings, Job } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { exportFileToken } from "~/db/exports";
import { ffmpegAvailable, ffmpegEncoders } from "~/providers/ffmpegEncoder";
import { epubFile, story, type EpubInput } from "../support/epub";
import { ffmpegJpeg, GIF, JPEG_HEAD, PNG } from "../support/images";
import { jsonBody, testApi, type TestApi } from "../support/server";

interface Imported {
  book: Book;
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}

// Two short chapters: long enough to read as story rather than a notice, short enough that an
// ffmpeg build of them takes a fraction of a second — the length of the audio is the build's cost.
const chapters = ["One", "Two"].map((title) => ({
  title,
  paragraphs: ["“We are short again,” said Mara.", ...story(1)],
}));

async function imported(api: TestApi, input: Partial<EpubInput> = {}): Promise<Book> {
  const { status, body } = await api.import<Imported>(await epubFile({ chapters, ...input }));
  expect(status).toBe(201);
  return body.book;
}

const upload = (api: TestApi, bookId: string, bytes: Uint8Array, name = "cover.png") => {
  const form = new FormData();
  form.set("file", new File([bytes], name));
  return api.request<{ cover: string } & Failure>(`/api/books/${bookId}/covers`, {
    method: "POST",
    body: form,
  });
};

const bytesAt = async (api: TestApi, url: string) => {
  const res = await api.fetch(url);
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
};

describe("the EPUB's cover", () => {
  test("is kept when the book is imported, and served where the book says", async () => {
    const api = testApi();
    const book = await imported(api, { cover: { bytes: PNG } });
    expect(book.coverImage).toMatch(
      new RegExp(`^/api/books/${book.id}/covers/[a-f0-9]{32}\\.png$`),
    );
    const served = await bytesAt(api, book.coverImage!);
    expect(served.status).toBe(200);
    expect(served.type).toBe("image/png");
    expect(served.bytes).toEqual(PNG);
    // and the shelf reads it too, once the book is on it
    await api.request(`/api/books/${book.id}/confirm`, { method: "POST" });
    const shelf = await api.request<{ books: Book[] }>("/api/books");
    expect(shelf.body.books[0].coverImage).toBe(book.coverImage);
  });

  test("is found the EPUB 2 way too, through the package's cover meta", async () => {
    const api = testApi();
    const book = await imported(api, {
      cover: { bytes: JPEG_HEAD, href: "Images/Cover%20Art.jpg", type: "image/jpeg", how: "epub2" },
    });
    expect(book.coverImage).toMatch(/\.jpg$/);
    expect((await bytesAt(api, book.coverImage!)).bytes).toEqual(JPEG_HEAD);
  });

  test("a cover that is not a JPEG or PNG, or is not in the file, leaves the book without one", async () => {
    const api = testApi();
    const gif = await imported(api, { title: "Gif", cover: { bytes: GIF, type: "image/gif" } });
    expect(gif.coverImage).toBeUndefined();
    const lost = await imported(api, { title: "Lost", cover: { bytes: PNG, missing: true } });
    expect(lost.coverImage).toBeUndefined();
    expect(lost.volumes).toHaveLength(1);
    expect(api.logs.some((l) => l.msg === "the cover is not a JPEG or PNG; it was not kept")).toBe(
      true,
    );
  });

  test("a volume added later does not replace the book's cover with its own", async () => {
    const api = testApi();
    const book = await imported(api);
    await api.request(`/api/books/${book.id}/confirm`, { method: "POST" });
    const { body } = await api.import<Imported>(
      await epubFile({ chapters, cover: { bytes: PNG } }),
      { bookId: book.id, name: "Vol. 2" },
    );
    expect(body.book.coverImage).toBeUndefined();
  });

  test("goes with the book when the book is removed", async () => {
    const api = testApi();
    const book = await imported(api, { cover: { bytes: PNG } });
    const dir = join(api.audioDir, book.id, "covers");
    expect(existsSync(dir)).toBe(true);
    await api.request(`/api/books/${book.id}`, { method: "DELETE" });
    for (let i = 0; i < 50 && existsSync(dir); i++) await new Promise((r) => setTimeout(r, 2));
    expect(existsSync(dir)).toBe(false);
  });
});

describe("an uploaded cover", () => {
  test("is kept under an address named by its bytes: the same image twice is one file", async () => {
    const api = testApi();
    const book = await imported(api);
    const first = await upload(api, book.id, PNG);
    expect(first.status).toBe(201);
    expect(first.body.cover).toMatch(
      new RegExp(`^/api/books/${book.id}/covers/[a-f0-9]{32}\\.png$`),
    );
    // named by what is in it, not by what the browser called it
    const again = await upload(api, book.id, PNG, "something-else.jpg");
    expect(again.body.cover).toBe(first.body.cover);
    expect((await bytesAt(api, first.body.cover)).bytes).toEqual(PNG);
    // it is the audiobook's, not the book's: the shelf's cover is unchanged
    const read = await api.request<Imported>(`/api/books/${book.id}`);
    expect(read.body.book.coverImage).toBeUndefined();
  });

  test("refuses what is not a JPEG or PNG, an empty file, one too large, and a book that is not there", async () => {
    const api = testApi();
    const book = await imported(api);
    const gif = await upload(api, book.id, GIF, "cover.png");
    expect(gif.status).toBe(415);
    expect(gif.body.error.message).toBe("A cover has to be a JPEG or PNG image");
    expect((await upload(api, book.id, new Uint8Array())).status).toBe(400);
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(PNG);
    const big = await upload(api, book.id, huge);
    expect(big.status).toBe(413);
    expect(big.body.error.message).toBe("That image is larger than 10 MB");
    expect((await upload(api, "nobody", PNG)).status).toBe(404);
  });

  test("an address that is not a cover of this book serves nothing", async () => {
    const api = testApi();
    const book = await imported(api, { cover: { bytes: PNG } });
    const other = await imported(api, { title: "Other" });
    const file = book.coverImage!.split("/").at(-1)!;
    expect((await bytesAt(api, `/api/books/${other.id}/covers/${file}`)).status).toBe(404);
    expect((await bytesAt(api, `/api/books/${book.id}/covers/..%2F..%2Fsecret.png`)).status).toBe(
      404,
    );
    expect((await bytesAt(api, `/api/books/${book.id}/covers/${"0".repeat(32)}.png`)).status).toBe(
      404,
    );
  });
});

// ---- building with a cover ----

const settingsFor = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  title: "Moonlight Ledger",
  filename: "Moonlight Ledger",
  normalize: false,
  ...over,
});

/** A book with a cover of its own, scripted and narrated, ready to build. */
async function narrated(api: TestApi, input: Partial<EpubInput> = { cover: { bytes: PNG } }) {
  const book = await imported(api, input);
  await api.request(`/api/books/${book.id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${book.id}/chapters/script`, jsonBody({ ids: [1, 2] }));
  await api.runner.idle();
  await api.request(`/api/books/${book.id}/chapters/narrate`, jsonBody({ ids: [1, 2] }));
  await api.runner.idle();
  return book;
}

const build = (api: TestApi, id: string, settings: ExportSettings) =>
  api.request<{ job: Job; export: ExportItem } & Failure>(
    `/api/books/${id}/exports`,
    jsonBody({ ids: [1, 2], settings }),
  );

const lastExport = async (api: TestApi, id: string) =>
  (await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`)).body.exports[0];

const notes = async (api: TestApi, jobId: number) =>
  ((await api.request<{ job: Job }>(`/api/jobs/${jobId}`)).body.job.activity ?? []).map(
    (e) => e.message,
  );

describe("a build and its cover", () => {
  test("names a cover only by the address it was uploaded to", async () => {
    const api = testApi();
    // refused before the build looks at a chapter, so the book needs no audio
    const book = await imported(api);
    await api.request(`/api/books/${book.id}/confirm`, { method: "POST" });
    const other = await imported(api, { title: "Other" });
    const theirs = (await upload(api, other.id, PNG)).body.cover;
    for (const cover of [`data:image/png;base64,${btoa("x")}`, theirs, "/api/audio/x/y.wav"]) {
      const { status, body } = await build(api, book.id, settingsFor({ cover }));
      expect(status).toBe(400);
      expect(body.error.message).toBe(
        "The cover image is not one this server holds; choose it again",
      );
    }
    expect(await lastExport(api, book.id)).toBeUndefined();
  });

  test("the stitcher writes no picture and no tags, and the build says so rather than leaving the promise", async () => {
    const api = testApi();
    const book = await narrated(api);
    const queued = await build(api, book.id, settingsFor());
    expect(queued.status).toBe(202);
    await api.runner.idle();
    expect((await lastExport(api, book.id)).status).toBe("done");
    const said = await notes(api, queued.body.job.id);
    expect(said).toContain("A .wav file carries no cover; the image was not written");
    expect(said).toContain(
      "A .wav file carries no title or author; the book's details were not written",
    );
  });

  test("a chosen cover gone from the server fails the build that names it", async () => {
    const api = testApi();
    const book = await narrated(api);
    const { cover } = (await upload(api, book.id, JPEG_HEAD, "c.jpg")).body;
    rmSync(join(api.audioDir, book.id, "covers", cover.split("/").at(-1)!));
    await build(api, book.id, settingsFor({ cover }));
    await api.runner.idle();
    expect((await lastExport(api, book.id)).status).toBe("failed");
    expect(JSON.stringify(api.logs)).toContain(
      "The cover image this build names is no longer on the server; choose it again",
    );
  });
});

const ffmpeg = await ffmpegAvailable();

/** The picture streams of a file, as ffprobe reads them. */
async function pictures(path: string): Promise<{ codec: string; attached: boolean }[]> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = JSON.parse(await new Response(proc.stdout).text()) as {
    streams: { codec_type: string; codec_name: string; disposition?: { attached_pic?: number } }[];
  };
  return out.streams
    .filter((s) => s.codec_type === "video")
    .map((s) => ({ codec: s.codec_name, attached: s.disposition?.attached_pic === 1 }));
}

/** What ffmpeg writes into every file whatever it is asked: its own name, and an MP4's brands. */
const UNASKED = new Set(["encoder", "major_brand", "minor_version", "compatible_brands"]);

/** The tags of a file's container, as ffprobe reads them, less the ones nobody asked for. */
async function tags(path: string): Promise<Record<string, string>> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const out = JSON.parse(await new Response(proc.stdout).text()) as {
    format: { tags?: Record<string, string> };
  };
  return Object.fromEntries(Object.entries(out.format.tags ?? {}).filter(([k]) => !UNASKED.has(k)));
}

const builtFile = (api: TestApi, bookId: string, exportId: number, position = 0): string =>
  api.exports.files.path(bookId, exportFileToken(api.db, exportId, position) ?? "") ?? "";

const details = {
  author: "Iris Vane",
  narrator: "Tom Hollis",
  series: "The Ledger Books",
  year: 2024,
  description: "A ledger that balances itself; a clerk who notices.",
};

describe.skipIf(!ffmpeg)("building with ffmpeg", () => {
  test("an M4B carries the EPUB's cover as its picture, and the book's details as its tags", async () => {
    const api = testApi({ encoder: ffmpegEncoders() });
    const book = await narrated(api);
    const queued = await build(api, book.id, settingsFor(details));
    await api.runner.idle();
    const done = await lastExport(api, book.id);
    expect(done.status).toBe("done");
    const path = builtFile(api, book.id, done.id);
    expect(await pictures(path)).toEqual([{ codec: "png", attached: true }]);
    // One file holding the whole book is the book: no track or disc number to give it.
    expect(await tags(path)).toEqual({
      title: "Moonlight Ledger",
      album: "Moonlight Ledger",
      artist: "Iris Vane",
      album_artist: "Iris Vane",
      composer: "Tom Hollis",
      grouping: "The Ledger Books",
      date: "2024",
      comment: details.description,
      description: details.description,
      genre: "Audiobook",
      media_type: "2",
    });
    const said = await notes(api, queued.body.job.id);
    expect(said).toContain("Embedding the EPUB's cover");
    expect(said).toContain("Tagging each file with the book's details");
  }, 120_000);

  test("an MP3 per chapter is tagged with its chapter and its place in the set, and a book with no cover gets no picture", async () => {
    const api = testApi({ encoder: ffmpegEncoders() });
    const book = await narrated(api, {});
    // A blank title is the book's own, and a blank narrator is left out rather than written empty.
    await build(
      api,
      book.id,
      settingsFor({ ...details, format: "mp3", grouping: "chapter", title: " ", narrator: "" }),
    );
    await api.runner.idle();
    const done = await lastExport(api, book.id);
    expect(done.status).toBe("done");
    for (const [i, chapter] of ["One", "Two"].entries()) {
      const path = builtFile(api, book.id, done.id, i);
      const said = await tags(path);
      expect(said).toMatchObject({
        title: chapter,
        album: book.title,
        artist: "Iris Vane",
        track: `${i + 1}/2`,
        date: "2024",
      });
      expect(said.composer).toBeUndefined();
      expect(said.disc).toBeUndefined();
      expect(await pictures(path)).toEqual([]);
    }
  }, 120_000);

  test("an MP3 carries the image chosen for it in place of the EPUB's", async () => {
    const api = testApi({ encoder: ffmpegEncoders() });
    const book = await narrated(api);
    const { cover } = (await upload(api, book.id, await ffmpegJpeg(), "mine.jpg")).body;
    await build(api, book.id, settingsFor({ format: "mp3", cover }));
    await api.runner.idle();
    const done = await lastExport(api, book.id);
    expect(done.status).toBe("done");
    expect(done.customCover).toBe(true);
    expect(await pictures(builtFile(api, book.id, done.id))).toEqual([
      { codec: "mjpeg", attached: true },
    ]);
  }, 120_000);
});
