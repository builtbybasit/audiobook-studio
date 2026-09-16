// The whole mock world in one object: what `makeWorld()` builds and what the store spreads into
// its state.
import type { Book, Chapter, Character, LexEntry } from "@/types/book";
import type { Endpoint } from "@/types/endpoint";
import type { ExportItem } from "@/types/export";
import type { SegmentMap } from "@/types/segment";

export interface World {
  books: Book[];
  chapters: Record<string, Chapter[]>;
  characters: Record<string, Character[]>;
  segments: SegmentMap;
  endpoints: Endpoint[];
  exports: ExportItem[];
  /** per book: the pronunciation dictionary, applied at render time */
  lexicon: Record<string, LexEntry[]>;
}
