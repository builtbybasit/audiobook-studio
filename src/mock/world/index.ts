// The mock world, assembled. Every call builds the whole thing from scratch — books, chapters, cast,
// scripts, clips, endpoints, dictionaries and finished exports — so nothing a session does to one
// world can be observed by the next one.
//
// Order matters: the cast has to exist before clips can record which voice rendered them, and the
// clips have to exist before an export can fingerprint the chapters it was built from.
import { rng } from "@/mock/random";
import { BOOK_SEEDS } from "@/mock/fixtures/books";
import { makeEndpoints } from "@/mock/fixtures/endpoints";
import { makeLexicon } from "@/mock/fixtures/lexicon";
import { makeProfiles } from "@/mock/fixtures/profiles";
import { makeVolumes, makeChapters } from "@/mock/world/chapters";
import { makeCharacters } from "@/mock/world/cast";
import { seedPipeline } from "@/mock/world/audio";
import { seedStory } from "@/mock/world/story";
import { makeExports } from "@/mock/world/exports";
import { voiceRef } from "@/mock/fixtures/voices";
import type { WorldDraft } from "@/mock/world/draft";
import type { Book, Chapter, Character, SegmentMap, World } from "@/types";

export function makeWorld(now: number = Date.now()): World {
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
    endpoints: makeEndpoints(now),
    // one clock for the whole world: the seeded promotions are dated from it, so every copy of
    // this world — and every `$reset()` back to it — agrees on when they start and end
    profiles: makeProfiles(now),
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
