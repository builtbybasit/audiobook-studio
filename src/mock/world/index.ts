// The mock world, assembled. Every call builds the whole thing from scratch — books, chapters, cast,
// scripts, clips, endpoints, dictionaries and finished exports — so nothing a session does to one
// world can be observed by the next one.
//
// Order matters: the cast has to exist before clips can record which voice rendered them, and the
// clips have to exist before an export can fingerprint the chapters it was built from.
import { rng } from "../random";
import { BOOK_SEEDS } from "../fixtures/books";
import { makeEndpoints } from "../fixtures/endpoints";
import { makeLexicon } from "../fixtures/lexicon";
import { makeVolumes, makeChapters } from "./chapters";
import { makeCharacters } from "./cast";
import { seedPipeline } from "./audio";
import { seedStory } from "./story";
import { makeExports } from "./exports";
import { voiceRef } from "../fixtures/voices";
import type { WorldDraft } from "./draft";
import type { Book, Chapter, Character, SegmentMap, World } from "@/types";

export function makeWorld(): World {
  const books: Book[] = [];
  const chapters: Record<string, Chapter[]> = {};
  const characters: Record<string, Character[]> = {};
  const segments: SegmentMap = {};
  const r = rng(42);

  for (const b of BOOK_SEEDS) {
    books.push({
      id: b.id,
      title: b.title,
      author: b.author,
      cover: b.cover,
      addedAt: "2026-08-2" + books.length,
      volumes: makeVolumes(b),
    });
    chapters[b.id] = makeChapters(b, r);
    characters[b.id] = makeCharacters(b);
  }

  const draft: WorldDraft = {
    books,
    chapters,
    characters,
    segments,
    endpoints: makeEndpoints(),
    lexicon: makeLexicon(),
  };

  seedPipeline(draft, "cliche", 12, 3);
  seedPipeline(draft, "starforge", 18, 18);
  seedPipeline(draft, "drowned", 2, 0);
  seedPipeline(draft, "gates", 214, 205, true);
  seedStory(draft);

  const exports = makeExports(draft);

  // one Drowned character sits on the paused Azure proxy → a routing blocker to fix
  const orphan = characters.drowned.filter((c) => c.major && c.name !== "Narrator")[1];
  if (orphan) orphan.voice = voiceRef("proxy", "onyx");

  return { ...draft, exports };
}
