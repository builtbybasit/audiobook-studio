// Choosing the image an audiobook carries.
//
// With a server answering, a build names its cover by the url the server gave for it — a `data:`
// URL in the build body is refused — so the store has to upload first and put that url in the
// settings, and a refused upload must leave the cover that was already chosen. These drive the
// real `HttpLibraryService` over a fake `fetch`, so what is asserted is the request that went out
// as well as what the store did with the answer. The demo half has nowhere to upload and holds the
// file as a `data:` URL.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { COVER_MAX_BYTES, coverRefusal, dataUrlOf, DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { HttpLibraryService, setLibraryService } from "@/services/library";
import { useExportsStore } from "@/stores/exports";
import { useUiStore } from "@/stores/ui";
import type { ExportSettings } from "@/types";
import { testPinia, type TestPinia } from "./support/pinia";

// the first bytes of a PNG, which is all the store and the fake server look at
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (name = "cover.png") => new File([PNG], name, { type: "image/png" });

let pinia: TestPinia | null = null;
let toasts: { msg: string; kind?: string; description?: string }[];
let asked: { path: string; method: string; file: File | null }[];
/** what the fake server answers the next upload with */
let answer: () => Response;

const settings = (): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS });

function start(backend: boolean) {
  // the ui store reads `matchMedia` as it is built, and the seeded world reaches for it too
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  asked = [];
  setLibraryService(
    backend
      ? new HttpLibraryService("/api", async (path, init) => {
          const body = init?.body;
          asked.push({
            path,
            method: init?.method ?? "GET",
            file: body instanceof FormData ? (body.get("file") as File | null) : null,
          });
          return answer();
        })
      : null,
  );
  pinia = testPinia();
  toasts = [];
  useUiStore().toast = (msg, opts = {}) => {
    toasts.push({ msg, kind: opts.kind, description: opts.description });
    return "";
  };
  return useExportsStore();
}

afterEach(() => {
  pinia?.stop();
  pinia = null;
  setLibraryService(null);
});

describe("which files can be a cover", () => {
  test("a JPEG or a PNG under the limit is fine", () => {
    expect(coverRefusal({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(coverRefusal({ type: "image/png", size: COVER_MAX_BYTES })).toBeNull();
  });

  test("anything else is turned away in the server's words", () => {
    for (const type of ["image/webp", "image/gif", "image/svg+xml", "application/pdf", ""])
      expect(coverRefusal({ type, size: 10 })).toBe("A cover has to be a JPEG or PNG image");
    expect(coverRefusal({ type: "image/png", size: COVER_MAX_BYTES + 1 })).toBe(
      "That image is larger than 10 MB",
    );
  });

  test("a data URL holds the file's bytes and its type", async () => {
    expect(await dataUrlOf(png())).toBe("data:image/png;base64,iVBORw0KGgo=");
    // larger than one slice of the conversion, so the slices have to join up
    const big = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256);
    const url = await dataUrlOf(new Blob([big], { type: "image/jpeg" }));
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(Buffer.from(url.split(",")[1], "base64").equals(Buffer.from(big))).toBe(true);
  });
});

describe("choosing a cover with a server answering", () => {
  beforeEach(() => {
    answer = () => Response.json({ cover: "/api/books/b1/covers/abc123.png" }, { status: 201 });
  });

  test("uploads the image and puts the url the server gave into the settings", async () => {
    const exportsStore = start(true);
    const s = settings();
    expect(await exportsStore.chooseCover("b1", s, png())).toBe(true);
    expect(s.cover).toBe("/api/books/b1/covers/abc123.png");
    expect(asked).toHaveLength(1);
    expect(asked[0].path).toBe("/api/books/b1/covers");
    expect(asked[0].method).toBe("POST");
    expect(asked[0].file?.name).toBe("cover.png");
    expect(toasts).toEqual([]);
  });

  test("a refused upload says why and leaves the cover as it was", async () => {
    // a PNG by its name and type that the server, reading the bytes, turns away
    answer = () =>
      Response.json(
        { error: { code: "bad_request", message: "The server read no image in that file" } },
        { status: 415 },
      );
    const exportsStore = start(true);
    const s = { ...settings(), cover: "/api/books/b1/covers/before.jpg" };
    expect(await exportsStore.chooseCover("b1", s, png("renamed.png"))).toBe(false);
    expect(s.cover).toBe("/api/books/b1/covers/before.jpg");
    expect(asked).toHaveLength(1);
    expect(toasts.at(-1)?.msg).toBe("The server read no image in that file");
    expect(toasts.at(-1)?.kind).toBe("error");
  });

  test("a file that is not a JPEG or a PNG is refused without a request", async () => {
    const exportsStore = start(true);
    const s = settings();
    const webp = new File([PNG], "cover.webp", { type: "image/webp" });
    expect(await exportsStore.chooseCover("b1", s, webp)).toBe(false);
    expect(asked).toEqual([]);
    expect(s.cover).toBeNull();
    // the same refusal the server would have sent, naming the file
    expect(toasts.at(-1)?.msg).toBe(coverRefusal(webp)!);
    expect(toasts.at(-1)?.description).toContain("cover.webp");
  });
});

describe("choosing a cover in the demo", () => {
  test("holds the image as a data URL, with nothing to ask", async () => {
    const exportsStore = start(false);
    const s = settings();
    expect(await exportsStore.chooseCover("b1", s, png())).toBe(true);
    expect(s.cover).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("keeps the server's rule about what a cover can be", async () => {
    const exportsStore = start(false);
    const s = settings();
    const gif = new File([PNG], "cover.gif", { type: "image/gif" });
    expect(await exportsStore.chooseCover("b1", s, gif)).toBe(false);
    expect(s.cover).toBeNull();
  });
});
