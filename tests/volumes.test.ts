// Cutting a book into volumes: the list of starts a cut, a join, a move and a rename answer, and
// the rows the Volumes tab draws from it. Pure functions over chapter ids, so nothing is seeded.
import { describe, expect, test } from "bun:test";

import {
  cutAt,
  evenly,
  every,
  joinAt,
  moveStart,
  renameAt,
  startsByTitles,
  volumeRows,
} from "@/lib/volumes";
import { chapterNumbers } from "@/lib/chapterNumber";
import type { Chapter, Volume } from "@/types";

const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const one = [{ chapter: 1, name: "Shadow" }];
const three = [
  { chapter: 1, name: "Shadow" },
  { chapter: 4, name: "Volume 2" },
  { chapter: 8, name: "Volume 3" },
];

describe("cut, join, move, rename", () => {
  test("a cut starts a volume there, named by its place; cutting at a start or the first chapter changes nothing", () => {
    expect(cutAt(one, ids, 4)).toEqual([one[0], { chapter: 4, name: "Volume 2" }]);
    expect(cutAt(three, ids, 6)).toEqual([
      three[0],
      three[1],
      { chapter: 6, name: "Volume 3" },
      three[2],
    ]);
    expect(cutAt(three, ids, 4)).toEqual(three);
    expect(cutAt(three, ids, 1)).toEqual(three);
    expect(cutAt(three, ids, 99)).toEqual(three);
  });

  test("a join removes that start, never the first", () => {
    expect(joinAt(three, 4)).toEqual([three[0], three[2]]);
    expect(joinAt(three, 1)).toEqual(three);
  });

  test("a move is clamped so it never reaches the start before or after it, and keeps the name", () => {
    expect(moveStart(three, ids, 4, 2)).toEqual([
      three[0],
      { chapter: 6, name: "Volume 2" },
      three[2],
    ]);
    expect(moveStart(three, ids, 4, -10)).toEqual([
      three[0],
      { chapter: 2, name: "Volume 2" },
      three[2],
    ]);
    expect(moveStart(three, ids, 4, 10)).toEqual([
      three[0],
      { chapter: 7, name: "Volume 2" },
      three[2],
    ]);
    expect(moveStart(three, ids, 8, 10)).toEqual([
      three[0],
      three[1],
      { chapter: 10, name: "Volume 3" },
    ]);
    expect(moveStart(three, ids, 1, 3)).toEqual(three);
  });

  test("a rename keeps the place and drops a blank name", () => {
    expect(renameAt(three, 4, " Arc 2 ")[1]).toEqual({ chapter: 4, name: "Arc 2" });
    expect(renameAt(three, 4, "  ")).toEqual(three);
  });
});

describe("cutting the whole book at once", () => {
  test("every n chapters, the first keeping its name", () => {
    expect(every(ids, 4, "Shadow")).toEqual([
      { chapter: 1, name: "Shadow" },
      { chapter: 5, name: "Volume 2" },
      { chapter: 9, name: "Volume 3" },
    ]);
    expect(every(ids, 100, "Shadow")).toEqual(one);
  });

  test("evenly into n volumes of about the same size", () => {
    expect(evenly(ids, 3, "Shadow").map((s) => s.chapter)).toEqual([1, 5, 9]);
    expect(evenly(ids, 2, "Shadow").map((s) => s.chapter)).toEqual([1, 6]);
  });

  test("where a title says a volume starts, the first chapter never counted", () => {
    const chapters = [
      { id: 1, title: "Volume 1: Dawn" },
      { id: 2, title: "Chapter 2" },
      { id: 3, title: "Book Two" },
      { id: 4, title: "Arc 3 – The Fall" },
      { id: 5, title: "Part IV" },
      { id: 6, title: "A bookish part" },
    ];
    expect(startsByTitles(chapters).map((c) => c.id)).toEqual([3, 4, 5]);
  });
});

describe("the rows the Volumes tab draws", () => {
  const chapter = (id: number, volumeId: number, excluded = false): Chapter => ({
    id,
    index: id,
    volumeId,
    volumeIndex: id,
    title: `Chapter ${id}`,
    words: 100,
    excluded,
    scripting: "none",
    scriptingProgress: 0,
    narration: "none",
    narrationProgress: 0,
    duration: 0,
  });
  const volume = (id: number, from: number, to: number): Volume => ({
    id,
    name: `Volume ${id}`,
    file: "",
    from,
    to,
  });

  test("reading numbers, counts and the room each boundary has to move", () => {
    const chapters = [
      chapter(1, 1, true),
      chapter(2, 1),
      chapter(3, 1),
      chapter(4, 2),
      chapter(5, 2, true),
      chapter(6, 3),
    ];
    const rows = volumeRows(
      [volume(1, 1, 3), volume(2, 4, 5), volume(3, 6, 6)],
      chapters,
      chapterNumbers(chapters),
    );
    expect(rows.map((r) => [r.from, r.to, r.included, r.words, r.startsHere])).toEqual([
      [1, 2, 2, 200, false],
      [3, 3, 1, 100, true],
      [4, 4, 1, 100, true],
    ]);
    expect(rows.map((r) => r.room)).toEqual([
      { back: 0, forward: 2 },
      { back: 2, forward: 1 },
      { back: 1, forward: 0 },
    ]);
    expect(rows[1].first.id).toBe(4);
  });
});
