// The narrated lines an effects sheet tries effects on, and who in the book thinks aloud.
//
// They are read off the scripts store, which the cast page fills with every scripted chapter
// (`useBookScripts`); this walks it once per subject and slot, not per row or per play, so a book of
// ~900 chapters is one pass when the sheet opens or switches. Chapter numbers stay out of it: the
// sheet shows a line's place among the subject's own lines, never where it falls in the book.
import { computed } from "vue";

import { heardLines } from "@/lib/siteText";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import type { SegmentType } from "@/types";

/** One narrated line, as the sheet plays it. */
export interface TryLine {
  key: string;
  speaker: string;
  type: SegmentType;
  text: string;
  /** the voice's own clip — the file beside one the effects made, when one was kept */
  url: string;
  duration: number;
}

/** Whose lines: one speaker's (all, or only their thoughts), or every thought line in the book. */
export type LinesOf = { speaker: string; thoughts: boolean } | { speaker: null; thoughts: true };

/** The narrated lines `of` asks for, in reading order; empty while `of` is null (sheet closed). */
export function useTryLines(bookId: () => string, of: () => LinesOf | null) {
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();
  return computed<TryLine[]>(() => {
    const want = of();
    if (!want) return [];
    const id = bookId();
    const book = libraryStore.bookById(id);
    const out: TryLine[] = [];
    for (const ch of libraryStore.chaptersOf(id)) {
      if (ch.excluded) continue;
      for (const s of heardLines(scriptsStore.segmentsOf(id, ch.id), book)) {
        if (want.speaker !== null && s.speaker !== want.speaker) continue;
        if (want.thoughts && s.type !== "thought") continue;
        const url = s.audio.raw ?? s.audio.url;
        if (!url) continue;
        out.push({
          key: `${ch.id}:${s.id}`,
          speaker: s.speaker,
          type: s.type,
          text: s.text,
          url,
          duration: s.audio.duration,
        });
      }
    }
    return out;
  });
}

/** Every speaker with a thought line in the book, narrated or not — whom its thought effect reaches. */
export function useThinkers(bookId: () => string, on: () => boolean) {
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();
  return computed<Set<string>>(() => {
    const who = new Set<string>();
    if (!on()) return who;
    const id = bookId();
    for (const ch of libraryStore.chaptersOf(id))
      if (!ch.excluded)
        for (const s of scriptsStore.segmentsOf(id, ch.id))
          if (s.type === "thought") who.add(s.speaker);
    return who;
  });
}
