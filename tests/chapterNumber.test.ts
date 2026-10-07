// Reading numbers: a chapter's place among the chapters the audiobook keeps, not its id in the file.
import { expect, test } from "bun:test";

import { chapterNumbers, chapterRef } from "@/lib/chapterNumber";

test("numbers the kept chapters from 1 in book order, a skipped cover and contents page left out", () => {
  const numbers = chapterNumbers([
    { id: 4 },
    { id: 1, excluded: true },
    { id: 3 },
    { id: 2, excluded: true },
    { id: 5, excluded: true },
    { id: 6 },
  ]);
  expect([...numbers]).toEqual([
    [3, 1],
    [4, 2],
    [6, 3],
  ]);
  expect(chapterRef(numbers.get(4))).toBe("ch 2");
  expect(chapterRef(numbers.get(5))).toBe("skipped");
});
