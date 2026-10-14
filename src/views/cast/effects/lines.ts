// The narrated lines an effects sheet tries effects on, and whom the book's thought effect reaches.
// One pass over the scripts store per subject and slot, not per row (~900 chapters). A line is
// placed among the subject's own lines, never by chapter.
import { computed } from "vue";

import { plural } from "@/lib/contents";
import { heardLines } from "@/lib/siteText";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import type { CastStat, Character, SegmentType } from "@/types";

/** One narrated line, as the sheet plays it. */
export interface TryLine {
  key: string;
  speaker: string;
  type: SegmentType;
  text: string;
  /** the voice's own clip, without effects */
  url: string;
  duration: number;
  /** the old effect is baked into the only file, so a tried effect plays on top of it */
  baked: boolean;
}

/** Whose lines: one speaker's or everyone's (`null`), all of them or only the thoughts. */
export interface LinesOf {
  speaker: string | null;
  thoughts: boolean;
}

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
          baked: !!s.audio.sound && !s.audio.raw,
        });
      }
    }
    return out;
  });
}

/** Whom the book's thought effect reaches, in words: "3 speakers use it · 1 has their own". */
export function thoughtReach(cast: Character[], stats: Record<string, CastStat>): string {
  let using = 0;
  let own = 0;
  for (const c of cast)
    if ((stats[c.name]?.thoughts ?? 0) > 0) {
      if (c.thoughts != null) own++;
      else using++;
    }
  if (!using && !own) return "no thought lines yet";
  return `${plural(using, "speaker uses", "speakers use")} it · ${own} ${own === 1 ? "has" : "have"} their own`;
}
