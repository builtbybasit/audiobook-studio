// Volumes and chapters: the skeleton a book gets before anything is scripted or narrated.
import type { Rng } from "../random";
import { bookSeed, type BookSeed } from "../fixtures/books";
import type { Chapter, Volume } from "@/types";

export function makeVolumes(book: BookSeed): Volume[] {
  let from = 1;
  return book.volumes.map(([name, file, n], i) => {
    const v: Volume = { id: i + 1, name, file, from, to: from + n - 1 };
    from += n;
    return v;
  });
}

export function makeChapters(book: BookSeed, r: Rng): Chapter[] {
  const list: Chapter[] = [];
  const vols = makeVolumes(book);
  for (let i = 1; i <= book.count; i++) {
    const t = book.titles[(i - 1) % book.titles.length];
    const vol = vols.find((v) => i >= v.from && i <= v.to);
    list.push({
      id: i,
      index: i,
      volumeId: vol?.id ?? 1,
      volumeIndex: vol ? i - vol.from + 1 : i,
      title: i > book.titles.length ? `${t} (II)` : t,
      words: 2200 + Math.floor(r() * 2400),
      scripting: "none",
      scriptingProgress: 0,
      narration: "none",
      narrationProgress: 0,
      duration: 0,
    });
  }
  return list;
}

/** The volumes of one seeded book, by id — what the export fixtures split their files along. */
export const volumesOfSeed = (id: string): Volume[] => makeVolumes(bookSeed(id));
