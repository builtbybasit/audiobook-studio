// A chapter as the player wants it: the clips and the silence between them. Built in one place so
// the ledger and the reader share queue id, clip ids and gaps, and neither restarts what the other
// is playing.
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

import { chapterTimeline } from "@/lib/speech";
import { fetchScript } from "@/queries/chapterScript";
import type { Queue } from "@/composables/usePlayer";

/** The player is app-wide, so a queue names its exact chapter: play on ch 7 while ch 6 runs must
 *  load ch 7, not toggle. */
export const chapterQueueId = (bookId: string, chId: number): string => `chapter:${bookId}:${chId}`;
/** The player's name for a line's clip, or one of its takes (`cand`, `take2`). The chapter is in
 *  it: line ids repeat across chapters, so `seg42` alone lit line 42 of every chapter. */
export const clipOf = (bookId: string, chId: number, segId: number, take?: string): string =>
  `${chapterQueueId(bookId, chId)}:seg${segId}${take ? `:${take}` : ""}`;

/** The line of this chapter under the playhead, or null. */
export function lineUnder(clipId: string | null, bookId: string, chId: number): number | null {
  const m = clipId?.match(/:seg(\d+)$/);
  return m && clipId === clipOf(bookId, chId, Number(m[1])) ? Number(m[1]) : null;
}

export interface ChapterQueueOptions {
  /** where the mini player takes you back to: the stage you started listening on */
  href?: (chId: number) => string;
  /** playback has run on into another chapter, so the page can follow it */
  onChapter?: (chId: number) => void;
}

/** Null when nothing in the chapter is rendered yet. */
export function chapterQueue(
  bookId: string,
  chId: number,
  opts: ChapterQueueOptions = {},
): Queue | null {
  const castStore = useCastStore();
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();

  const timeline = chapterTimeline(
    scriptsStore.segmentsOf(bookId, chId),
    castStore.pacingOf(bookId),
    libraryStore.bookById(bookId),
  );
  if (!timeline.length) return null;
  return {
    id: chapterQueueId(bookId, chId),
    title: libraryStore.chapter(bookId, chId)?.title ?? "",
    subtitle: libraryStore.bookById(bookId)?.title ?? "",
    href: opts.href?.(chId),
    clips: timeline.map(({ s, gap }) => ({
      id: clipOf(bookId, chId, s.id),
      duration: s.audio.duration,
      gap,
      url: s.audio.url,
      label: s.text,
      speaker: s.speaker,
    })),
    // Listening through a book shouldn't stop at a chapter boundary. The next kept chapter with
    // audio is read if no page has read it yet; one already read keeps any edit in progress.
    next: async () => {
      const chapters = libraryStore.chaptersOf(bookId);
      for (const c of chapters.slice(chapters.findIndex((x) => x.id === chId) + 1)) {
        if (c.excluded || !c.duration) continue;
        if (!scriptsStore.segmentsOf(bookId, c.id).length) await fetchScript(bookId, c.id);
        const q = chapterQueue(bookId, c.id, opts);
        if (!q) continue;
        opts.onChapter?.(c.id);
        return q;
      }
      return null;
    },
  };
}

/** Where a line starts in the chapter's timeline, silence included. Null for a line with no audio
 *  of its own. */
export function segmentStart(bookId: string, chId: number, segId: number): number | null {
  const castStore = useCastStore();
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();

  return (
    chapterTimeline(
      scriptsStore.segmentsOf(bookId, chId),
      castStore.pacingOf(bookId),
      libraryStore.bookById(bookId),
    ).find((x) => x.s.id === segId)?.start ?? null
  );
}
