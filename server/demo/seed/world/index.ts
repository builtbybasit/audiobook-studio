// The mock world, built from scratch on every call. Order matters: cast before clips (which record
// their voice), clips before exports (which fingerprint them).
import { rng } from "~/demo/seed/random";
import { BOOK_SEEDS } from "~/demo/seed/fixtures/books";
import { makeEndpoints } from "~/demo/seed/fixtures/endpoints";
import { makeLexicon } from "~/demo/seed/fixtures/lexicon";
import { makeProfiles } from "~/demo/seed/fixtures/profiles";
import { makeVolumes, makeChapters } from "~/demo/seed/world/chapters";
import { makeCharacters } from "~/demo/seed/world/cast";
import { seedPipeline } from "~/demo/seed/world/audio";
import { seedStory } from "~/demo/seed/world/story";
import { makeExports } from "~/demo/seed/world/exports";
import { voiceRef } from "~/demo/seed/fixtures/voices";
import type { WorldDraft } from "~/demo/seed/world/draft";
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
    // one clock, so every copy of the world agrees on promotion dates
    profiles: makeProfiles(now),
    lexicon: makeLexicon(),
  };

  seedPipeline(draft, "cliche", 12, 3, now);
  seedPipeline(draft, "starforge", 18, 18, now);
  seedPipeline(draft, "drowned", 2, 0, now);
  seedPipeline(draft, "gates", 214, 205, now, true);
  seedStory(draft, now);

  const exports = makeExports(draft);

  // one Drowned character sits on the paused Azure proxy → a routing blocker to fix
  const orphan = characters.drowned.filter((c) => c.major && c.name !== "Narrator")[1];
  if (orphan) orphan.voice = voiceRef("proxy", "onyx");

  return { ...draft, exports };
}
