// A chapter as the player wants it: the clips, and the silence stitched between them.
//
// Two stages press play on the same chapter — the narration ledger, which is about the audio, and
// the script reader, which is about the words — and a chapter has one timeline whichever page you
// are on. Building it in one place means the queue's id, its clip ids and its gaps are the same
// from both, so a line started in the reader keeps playing into the ledger's chapter, the mini
// player says the same thing, and neither page restarts what the other is already playing.
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

import { pauseAfter } from "@/lib/speech";
import type { Queue } from "@/composables/usePlayer";

/** The player is app-wide, so a queue has to name this exact chapter: pressing play on ch 7 while
 *  ch 6 is still going must load ch 7, not toggle the bar. */
export const chapterQueueId = (bookId: string, chId: number): string => `chapter:${bookId}:${chId}`;
/** the player's name for one line's clip */
export const clipOf = (segId: number): string => `seg${segId}`;

export interface ChapterQueueOptions {
  /** where the mini player takes you back to — the stage you started listening on */
  href?: (chId: number) => string;
  /** playback has run on into another chapter, so the page can follow it */
  onChapter?: (chId: number) => void;
}

/** Null when nothing in the chapter has been rendered yet — there is no timeline to play. */
export function chapterQueue(
  bookId: string,
  chId: number,
  opts: ChapterQueueOptions = {},
): Queue | null {
  const castStore = useCastStore();
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();

  const heard = scriptsStore.segmentsOf(bookId, chId).filter((s) => s.audio.duration > 0);
  if (!heard.length) return null;
  const pace = castStore.pacingOf(bookId);
  return {
    id: chapterQueueId(bookId, chId),
    title: libraryStore.chapter(bookId, chId)?.title ?? "",
    subtitle: libraryStore.bookById(bookId)?.title ?? "",
    href: opts.href?.(chId),
    clips: heard.map((s, i) => ({
      id: clipOf(s.id),
      duration: s.audio.duration,
      gap: pauseAfter(s, heard[i + 1], pace),
      url: s.audio.url,
      label: s.text,
      speaker: s.speaker,
    })),
    // listening through a book shouldn't stop at a chapter boundary
    next: () => {
      const chapters = libraryStore.chaptersOf(bookId);
      for (const c of chapters.slice(chapters.findIndex((x) => x.id === chId) + 1)) {
        const q = chapterQueue(bookId, c.id, opts);
        if (!q) continue;
        opts.onChapter?.(c.id);
        return q;
      }
      return null;
    },
  };
}

/** Where a line starts in the chapter's timeline, silence included, so "play from here" can.
 *  Null for a line with no audio of its own — it isn't in the timeline at all. */
export function segmentStart(bookId: string, chId: number, segId: number): number | null {
  const castStore = useCastStore();
  const scriptsStore = useScriptsStore();

  const heard = scriptsStore.segmentsOf(bookId, chId).filter((s) => s.audio.duration > 0);
  const pace = castStore.pacingOf(bookId);
  let t = 0;
  for (const [i, s] of heard.entries()) {
    if (s.id === segId) return t;
    t += s.audio.duration + pauseAfter(s, heard[i + 1], pace);
  }
  return null;
}
