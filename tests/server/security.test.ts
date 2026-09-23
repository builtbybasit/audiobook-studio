// What the API refuses before it does any work: an upload that unzips to more than the server will
// hold, a zip that lies about what it unzips to, a request another site made the browser send, and
// a body too big to buffer. Each is refused in the API's one error shape.
import { describe, expect, test } from "bun:test";

import JSZip from "jszip";

import { checkArchive } from "~/epub/archive";
import { EpubParseError } from "~/epub/parse";
import { AppError } from "~/lib/errors";
import { buildEpub, story } from "../support/epub";
import { testApi } from "../support/server";

const MB = 1024 * 1024;

interface Refusal {
  error: { code: string; message: string; detail?: string };
}

/** A zip of the given entries, deflated, which is what makes a small file a big one. */
async function zipOf(entries: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(entries)) zip.file(name, data);
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

/**
 * The same zip, claiming the named entry unzips to `size` bytes.
 *
 * Both copies of the claim are rewritten — the local header's and the central directory's — so the
 * archive agrees with itself and only inflating it shows the lie.
 */
function claiming(bytes: ArrayBuffer, name: string, size: number): ArrayBuffer {
  const out = Buffer.from(bytes);
  const named = (at: number, length: number) => out.toString("utf8", at, at + length) === name;
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50 && named(i + 30, out.readUInt16LE(i + 26)))
      out.writeUInt32LE(size, i + 22);
    if (sig === 0x02014b50 && named(i + 46, out.readUInt16LE(i + 28)))
      out.writeUInt32LE(size, i + 24);
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

/** A real EPUB whose one chapter is `bytes` long, and compresses to almost nothing. */
async function bomb(bytes: number): Promise<ArrayBuffer> {
  const epub = await JSZip.loadAsync(
    await buildEpub({ chapters: [{ title: "One", paragraphs: story() }] }),
  );
  const filler = "<p>" + "a".repeat(bytes) + "</p>";
  epub.file(
    "OEBPS/c1.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${filler}</body></html>`,
  );
  return epub.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

const upload = (bytes: ArrayBuffer, name = "book.epub"): File =>
  new File([bytes], name, { type: "application/epub+zip" });

describe("measuring what an upload unzips to", () => {
  const limits = { total: 4 * MB, document: 1 * MB };

  test("an archive inside the limits says what it holds", async () => {
    const size = await checkArchive(
      await zipOf({ "a.xhtml": "x".repeat(1000), "b.jpg": "y" }),
      limits,
    );
    expect(size).toEqual({ entries: 2, bytes: 1001 });
  });

  test("one document over its limit is refused before it is inflated", async () => {
    const e = await checkArchive(
      await zipOf({ "OEBPS/c1.xhtml": "a".repeat(2 * MB) }),
      limits,
    ).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(413);
    expect((e as AppError).detail).toContain("OEBPS/c1.xhtml unzips to 2.0 MB");
  });

  test("an image is held to the total, not to the limit on a document", async () => {
    // Pictures are carried, not parsed, and a picture book's images are most of it.
    const big = new Uint8Array(2 * MB).fill(7);
    expect(await checkArchive(await zipOf({ "cover.jpg": big }), limits)).toEqual({
      entries: 1,
      bytes: 2 * MB,
    });
    const e = await checkArchive(
      await zipOf({ "a.jpg": big, "b.jpg": big, "c.jpg": big }),
      limits,
    ).catch((e: unknown) => e);
    expect((e as AppError).status).toBe(413);
    expect((e as AppError).message).toBe("That EPUB unzips to more than this server will read");
  });

  test("an archive that claims to be smaller than it is, is caught inflating", async () => {
    const lying = claiming(await zipOf({ "c1.xhtml": "a".repeat(2 * MB) }), "c1.xhtml", 1000);
    const e = await checkArchive(lying, limits).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(415);
    expect((e as AppError).detail).toContain("c1.xhtml inflates to more than");
  });

  test("a file that is not a zip is left for the import to explain", async () => {
    const e = await checkArchive(new TextEncoder().encode("not a zip").buffer, limits).catch(
      (e: unknown) => e,
    );
    expect(e).toBeInstanceOf(EpubParseError);
  });
});

describe("importing an EPUB that unzips to too much", () => {
  test("a small upload with an enormous chapter is refused as too large, not parsed", async () => {
    const api = testApi();
    const bytes = await bomb(40 * MB);
    // The point of the check: the upload is nowhere near the upload limit.
    expect(bytes.byteLength).toBeLessThan(1 * MB);
    const { status, body } = await api.import<Refusal>(upload(bytes));
    expect(status).toBe(413);
    expect(body.error.code).toBe("too_large");
    expect(body.error.message).toBe("A file inside that EPUB is too large to read");
    expect(body.error.detail).toContain("MAX_DOCUMENT_MB");
    // Nothing was stored, and nothing is waiting in a review.
    expect((await api.request<{ books: unknown[] }>("/api/books")).body.books).toEqual([]);
  });

  test("one that lies about its size is refused without a diagnosis", async () => {
    // EPUBCheck would unzip the whole thing to explain it, which is what the refusal prevents.
    const api = testApi();
    const { status, body } = await api.import<Refusal>(
      upload(claiming(await bomb(2 * MB), "OEBPS/c1.xhtml", 500)),
    );
    expect(status).toBe(415);
    expect(body.error.detail).toContain("inflates to more than");
    expect(body.error.detail).not.toContain("EPUBCheck");
  });
});

describe("a request another site made the browser send", () => {
  const post = (headers: Record<string, string>) =>
    testApi().request<Refusal>("/api/jobs/clear", { method: "POST", headers });

  test("is refused when the browser says it came from another site", async () => {
    const { status, body } = await post({
      origin: "https://elsewhere.example",
      "sec-fetch-site": "cross-site",
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toBe("That request came from another site, and was refused");
  });

  test("is refused on its origin alone, from a browser that sends no fetch metadata", async () => {
    expect((await post({ origin: "https://elsewhere.example" })).status).toBe(403);
  });

  test("a form post from another site is refused before the upload is read", async () => {
    const api = testApi();
    const form = new FormData();
    form.set(
      "file",
      upload(await buildEpub({ chapters: [{ title: "One", paragraphs: story() }] })),
    );
    const { status } = await api.request("/api/books/import", {
      method: "POST",
      body: form,
      headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" },
    });
    expect(status).toBe(403);
    expect((await api.request<{ books: unknown[] }>("/api/books")).body.books).toEqual([]);
  });

  test("the app's own page is let through, and so is anything that is not a browser", async () => {
    expect(
      (await post({ origin: "http://[::1]:5173", "sec-fetch-site": "same-origin" })).status,
    ).toBe(200);
    expect((await post({})).status).toBe(200);
  });

  test("reading is not refused: another site cannot see the answer anyway", async () => {
    const { status } = await testApi().request("/api/books", {
      headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" },
    });
    expect(status).toBe(200);
  });
});

describe("what every response carries, and how a malformed request is answered", () => {
  test("responses say not to sniff, frame or borrow them", async () => {
    const res = await testApi().fetch("/api/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("an upload that is not the multipart it claims is refused in the API's shape", async () => {
    const res = await testApi().fetch("/api/books/import", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=xyz" },
      body: '--xyz\r\nContent-Disposition: form-data; name="file"\r\n\r\nno final boundary',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Refusal;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("Malformed FormData");
  });

  test("a body that is not the JSON it claims is refused in the API's shape", async () => {
    const res = await testApi().fetch("/api/books/x/chapters/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Refusal;
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toContain("Malformed JSON");
  });

  test("an upload over the limit is refused from its length, before it is read", async () => {
    const { status, body } = await testApi().request<Refusal>("/api/books/import", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(500 * MB),
      },
      body: "--x--",
    });
    expect(status).toBe(413);
    expect(body.error.code).toBe("too_large");
    expect(body.error.detail).toContain("MAX_UPLOAD_MB");
  });
});
