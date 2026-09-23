// A clip a part at a time: what `<audio>` asks for when it seeks. The audiobook route answers
// the same way through the same helper; its case is in exports.test.ts, beside its download.
//
// Bun answers a `Range` on a file response with the whole file and a 200, so without this a player
// could not seek, and one that insists on ranges would not play at all.
import { describe, expect, test } from "bun:test";

import { testApi } from "../support/server";

/** 256 bytes, each its own position, so a slice says where it came from. */
const BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

async function clip() {
  const api = testApi();
  const { url } = await api.files.write("ranges", BYTES, "wav");
  const get = (headers: Record<string, string> = {}) => api.fetch(url, { headers });
  const head = () => api.fetch(url, { method: "HEAD" });
  return { get, head };
}

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("serving a clip a part at a time", () => {
  test("the whole file says a part may be asked for", async () => {
    const { get } = await clip();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(await bytesOf(res)).toEqual(BYTES);
  });

  test("a HEAD says how long the file is, without sending it", async () => {
    // Answered by the GET route with the body taken off, which would otherwise count as nothing.
    const { head } = await clip();
    const res = await head();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("256");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("a range is that part, and says where in the file it sits", async () => {
    const { get } = await clip();
    const res = await get({ range: "bytes=10-19" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(await bytesOf(res)).toEqual(BYTES.slice(10, 20));
  });

  test("an open range runs to the end, and a suffix is the last bytes", async () => {
    const { get } = await clip();
    const open = await get({ range: "bytes=250-" });
    expect(open.headers.get("content-range")).toBe("bytes 250-255/256");
    expect(await bytesOf(open)).toEqual(BYTES.slice(250));

    const suffix = await get({ range: "bytes=-4" });
    expect(suffix.headers.get("content-range")).toBe("bytes 252-255/256");
    expect(await bytesOf(suffix)).toEqual(BYTES.slice(252));
  });

  test("a range past the end is a 416 that says how big the file is", async () => {
    const { get } = await clip();
    const res = await get({ range: "bytes=999-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */256");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("range_not_satisfiable");
  });

  test("a header this does not answer gets the whole file rather than a refusal", async () => {
    // A server may always ignore `Range`; a player never asks for several ranges at once.
    const { get } = await clip();
    for (const range of ["nonsense", "items=0-1", "bytes=0-1,10-11"]) {
      const res = await get({ range });
      expect(res.status).toBe(200);
      expect(await bytesOf(res)).toEqual(BYTES);
    }
  });
});
