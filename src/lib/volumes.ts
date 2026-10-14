// Cutting a book into volumes, as pure arithmetic over `VolumeStart[]` (reading order, the first at
// the first chapter). The store writes the list whole, so each edit is one write.
import type { Chapter, Volume, VolumeStart } from "@/types";

const sorted = (starts: readonly VolumeStart[]): VolumeStart[] =>
  [...starts].sort((a, b) => a.chapter - b.chapter);

/** Cutting at an existing start changes nothing. */
export function cutAt(
  starts: readonly VolumeStart[],
  chapterIds: readonly number[],
  chapterId: number,
): VolumeStart[] {
  if (!chapterIds.includes(chapterId) || starts.some((s) => s.chapter === chapterId))
    return [...starts];
  const position = starts.filter((s) => s.chapter < chapterId).length;
  return sorted([...starts, { chapter: chapterId, name: `Volume ${position + 1}` }]);
}

/** Joins with the volume before. The first never goes. */
export function joinAt(starts: readonly VolumeStart[], chapterId: number): VolumeStart[] {
  return starts.filter((s, i) => i === 0 || s.chapter !== chapterId);
}

/** Clamped so no volume is left empty. The first start never moves. */
export function moveStart(
  starts: readonly VolumeStart[],
  chapterIds: readonly number[],
  chapterId: number,
  delta: number,
): VolumeStart[] {
  const k = starts.findIndex((s) => s.chapter === chapterId);
  const i = chapterIds.indexOf(chapterId);
  if (k < 1 || i < 0) return [...starts];
  const lo = chapterIds.indexOf(starts[k - 1].chapter) + 1;
  const hi = (starts[k + 1] ? chapterIds.indexOf(starts[k + 1].chapter) : chapterIds.length) - 1;
  const j = Math.max(lo, Math.min(hi, i + delta));
  return starts.map((s, n) => (n === k ? { ...s, chapter: chapterIds[j] } : s));
}

export function renameAt(
  starts: readonly VolumeStart[],
  chapterId: number,
  name: string,
): VolumeStart[] {
  const next = name.trim();
  return starts.map((s) => (s.chapter === chapterId && next ? { ...s, name: next } : s));
}

/** The first keeps `firstName`; the rest are "Volume k". */
export function atChapters(
  chapterIds: readonly number[],
  cutIds: readonly number[],
  firstName: string,
): VolumeStart[] {
  const cuts = [...new Set(cutIds)]
    .filter((id) => chapterIds.includes(id) && id !== chapterIds[0])
    .sort((a, b) => chapterIds.indexOf(a) - chapterIds.indexOf(b));
  return [
    { chapter: chapterIds[0], name: firstName },
    ...cuts.map((chapter, k) => ({ chapter, name: `Volume ${k + 2}` })),
  ];
}

export function every(chapterIds: readonly number[], n: number, firstName: string): VolumeStart[] {
  const step = Math.max(1, Math.floor(n));
  return atChapters(
    chapterIds,
    chapterIds.filter((_, i) => i > 0 && i % step === 0),
    firstName,
  );
}

export function evenly(chapterIds: readonly number[], n: number, firstName: string): VolumeStart[] {
  return every(chapterIds, Math.ceil(chapterIds.length / Math.max(1, n)), firstName);
}

/** "Volume 2", "Book Two", "Arc 3", "Part IV" */
export const TITLE_START =
  /\b(?:volume|book|arc|part)\s+(?:\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

export function startsByTitles<T extends Pick<Chapter, "id" | "title">>(
  chapters: readonly T[],
): T[] {
  return chapters.filter((c, i) => i > 0 && TITLE_START.test(c.title));
}

export interface VolumeRowInfo {
  id: number;
  name: string;
  all: Chapter[];
  first: Chapter;
  last: Chapter;
  /** reading numbers; none while every chapter of it is skipped */
  from: number | undefined;
  to: number | undefined;
  included: number;
  /** of included chapters */
  words: number;
  /** every volume but the first begins at a boundary that can be moved or joined */
  startsHere: boolean;
  /** chapters its start can move without reaching another start */
  room: { back: number; forward: number };
}

export function volumeRows(
  volumes: readonly Volume[],
  chapters: readonly Chapter[],
  numbers: ReadonlyMap<number, number> | undefined,
): VolumeRowInfo[] {
  const starts = volumes
    .map((v) => ({ v, i: chapters.findIndex((c) => c.volumeId === v.id) }))
    .filter((s) => s.i >= 0);
  return starts.map(({ v, i }, n) => {
    const end = starts[n + 1]?.i ?? chapters.length;
    const all = chapters.slice(i, end);
    const ns = all.map((c) => numbers?.get(c.id)).filter((x): x is number => x != null);
    return {
      id: v.id,
      name: v.name,
      all,
      first: all[0],
      last: all[all.length - 1],
      from: ns[0],
      to: ns[ns.length - 1],
      included: all.filter((c) => !c.excluded).length,
      words: all.reduce((a, c) => a + (c.excluded ? 0 : c.words), 0),
      startsHere: n > 0,
      room: { back: i - ((starts[n - 1]?.i ?? -1) + 1), forward: end - i - 1 },
    };
  });
}
