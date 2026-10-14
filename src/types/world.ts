// The whole mock world: what `makeWorld()` builds and the store spreads into its state.
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
   * Part of the world because their rate cards carry dates (a promotion ending Friday); a
   * `$reset()` rebuilding them against a newer clock would hand back a different world.
   */
  profiles: Profile[];
  exports: ExportItem[];
  /** per book: the pronunciation dictionary, applied at render time */
  lexicon: Record<string, LexEntry[]>;
}
