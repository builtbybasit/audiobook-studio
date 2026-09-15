// The whole mock world in one object: what `makeWorld()` builds and what the store spreads into
// its state.
import type { Book, Chapter, Character, LexEntry } from "./book";
import type { Endpoint } from "./endpoint";
import type { ExportItem } from "./export";
import type { SegmentMap } from "./segment";

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
