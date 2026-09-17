// The whole mock world in one object: what `makeWorld()` builds and what the store spreads into
// its state.
import type { Book, Chapter, Character, LexEntry } from "@/types/book";
import type { Endpoint } from "@/types/endpoint";
import type { ExportItem } from "@/types/export";
import type { Profile } from "@/types/scripting";
import type { SegmentMap } from "@/types/segment";

export interface World {
  books: Book[];
  chapters: Record<string, Chapter[]>;
  characters: Record<string, Character[]>;
  segments: SegmentMap;
  endpoints: Endpoint[];
  /**
   * The scripting endpoints. Part of the world rather than built fresh in the store, because their
   * rate cards carry dates — a promotion that ends on Friday — and a `$reset()` that rebuilt them
   * against a newer clock would hand back a world subtly different from the one it was restoring.
   */
  profiles: Profile[];
  exports: ExportItem[];
  /** per book: the pronunciation dictionary, applied at render time */
  lexicon: Record<string, LexEntry[]>;
}
