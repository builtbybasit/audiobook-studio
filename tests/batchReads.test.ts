// One-chapter reads asked for in the same tick go out together (`src/queries/batch.ts`): a long
// book is a few requests, not thousands, and each request's answers land together.
import { expect, test } from "bun:test";

import { batchReads } from "@/queries/batch";
import { ApiError } from "@/services/http";

function reader(fail?: unknown) {
  const loads: [string, number[]][] = [];
  const read = batchReads(async (group, ids) => {
    loads.push([group, ids]);
    if (fail) throw fail;
    // chapter 13 is not one of the book's
    return Object.fromEntries(ids.filter((i) => i !== 13).map((i) => [i, `${group}:${i}`]));
  });
  return { read, loads };
}

test("reads asked for together go as one request per group, at most 200 chapters each", async () => {
  const { read, loads } = reader();
  const ids = Array.from({ length: 450 }, (_, i) => i + 100);
  const got = await Promise.all([...ids.map((i) => read("a", i)), read("b", 1), read("a", 100)]);
  expect(loads.map(([g, l]) => [g, l.length])).toEqual([
    ["a", 200],
    ["a", 200],
    ["a", 50],
    ["b", 1],
  ]);
  // each caller gets its own chapter, a chapter asked for twice is read once and given to both
  expect(got.slice(0, 2)).toEqual(["a:100", "a:101"]);
  expect(got.slice(-2)).toEqual(["b:1", "a:100"]);
  // a read asked for later is a request of its own
  expect(await read("a", 5)).toBe("a:5");
  expect(loads).toHaveLength(5);
});

test("a chapter left out is not found; a request that fails fails each of its reads", async () => {
  const { read } = reader();
  const [missing, found] = await Promise.allSettled([read("a", 13), read("a", 14)]);
  expect(missing.status === "rejected" && (missing.reason as ApiError).status).toBe(404);
  expect(found).toEqual({ status: "fulfilled", value: "a:14" });

  const down = new ApiError("Could not reach the server", 0);
  const failing = reader(down).read;
  const all = await Promise.allSettled([failing("a", 1), failing("a", 2)]);
  expect(all).toEqual([
    { status: "rejected", reason: down },
    { status: "rejected", reason: down },
  ]);
});
