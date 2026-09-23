import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// The mock world and its fixtures.
//
// Two properties matter here and neither is visible from a screenshot. A world is *fresh*: two
// calls to `makeWorld()` share nothing, so editing one book cannot be observed through another, and
// the hand-authored seeds are never written back to. And a world *holds together*: every reference
// in it — a voice, a volume, a speaker, an exported chapter — points at something that exists.
//
// What the demo store does with this world — the scenarios, the page chips and their resets — is in
// `demo.test.ts`.
import { test, expect, beforeAll, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import {
  BOOK_SEEDS,
  exportScenarios,
  makeEndpoints,
  makeLexicon,
  makeProfiles,
  makeWorld,
  searchDemoTarget,
  searchScenarios,
} from "@/mock";
import type { World } from "@/types";

describe("fixtures are fresh", () => {
  test("two worlds share no mutable state", () => {
    const a = makeWorld();
    const b = makeWorld();

    a.characters.cliche[0].aliases.push("scribbled-in");
    a.characters.cliche[0].name = "Renamed";
    a.endpoints[0].voices.push({ id: "ghost", gender: "n", label: "Ghost" });
    a.endpoints[0].enabled = false;
    a.lexicon.cliche[0].say = "changed";
    a.segments["cliche:1"][0].text = "rewritten";
    a.chapters.cliche[0].title = "Retitled";

    expect(b.characters.cliche[0].aliases).not.toContain("scribbled-in");
    expect(b.characters.cliche[0].name).not.toBe("Renamed");
    expect(b.endpoints[0].voices.some((v) => v.id === "ghost")).toBe(false);
    expect(b.endpoints[0].enabled).toBe(true);
    expect(b.lexicon.cliche[0].say).not.toBe("changed");
    expect(b.segments["cliche:1"][0].text).not.toBe("rewritten");
    expect(b.chapters.cliche[0].title).not.toBe("Retitled");
  });

  test("the hand-authored seeds are never written back to", () => {
    const before = JSON.stringify(BOOK_SEEDS);
    const w = makeWorld();
    for (const c of w.characters.cliche) {
      c.aliases.push("mutated");
      c.description = "mutated";
    }
    expect(JSON.stringify(BOOK_SEEDS)).toBe(before);
  });

  test("every fixture factory hands back its own copy", () => {
    expect(makeEndpoints()[0]).not.toBe(makeEndpoints()[0]);
    expect(makeProfiles()[0]).not.toBe(makeProfiles()[0]);
    expect(makeLexicon().cliche).not.toBe(makeLexicon().cliche);
    expect(exportScenarios()).not.toBe(exportScenarios());
  });
});

describe("the world holds together", () => {
  // these only read, so one world serves them all
  let w: World;
  beforeAll(() => {
    w = makeWorld();
  });

  test("every speaker routes to a voice that exists on an endpoint that exists", () => {
    for (const [bookId, cast] of Object.entries(w.characters))
      for (const c of cast) {
        if (!c.voice) continue;
        const [epId, voiceId] = [c.voice.slice(0, c.voice.indexOf("/")), c.voice.split("/")[1]];
        const ep = w.endpoints.find((e) => e.id === epId);
        expect(ep, `${bookId}/${c.name} → ${c.voice}`).toBeDefined();
        expect(
          ep!.voices.some((v) => v.id === voiceId),
          `${bookId}/${c.name}`,
        ).toBe(true);
      }
  });

  test("every book has a Narrator, so an unvoiced speaker always has a fallback", () => {
    for (const bookId of Object.keys(w.characters)) {
      const narrator = w.characters[bookId].find((c) => c.name === "Narrator");
      expect(narrator, bookId).toBeDefined();
      expect(narrator!.voice, bookId).toBeTruthy();
    }
  });

  test("chapters, volumes and segments agree", () => {
    for (const b of w.books) {
      const ids = new Set(w.chapters[b.id].map((c) => c.id));
      for (const c of w.chapters[b.id])
        expect(
          b.volumes.some((v) => v.id === c.volumeId),
          `${b.id} ch ${c.id}`,
        ).toBe(true);
      for (const k of Object.keys(w.segments))
        if (k.startsWith(b.id + ":")) expect(ids.has(Number(k.split(":")[1])), k).toBe(true);
    }
  });

  test("every speaker in a script is in the book's cast", () => {
    for (const [k, segs] of Object.entries(w.segments)) {
      const names = new Set(w.characters[k.split(":")[0]].map((c) => c.name));
      for (const s of segs) expect(names.has(s.speaker), `${k} · ${s.speaker}`).toBe(true);
    }
  });

  test("every finished export names chapters the book still has", () => {
    for (const e of w.exports) {
      const ids = new Set(w.chapters[e.bookId].map((c) => c.id));
      for (const id of e.chapterIds) expect(ids.has(id), `${e.filename} ch ${id}`).toBe(true);
    }
  });

  test("the search scenario rows describe the character they were built from", () => {
    const target = searchDemoTarget(w.characters.cliche)!;
    const row = (id: string) => searchScenarios(target).find((r) => r.id === id)!;
    // the alias is what the model scattered; the main name is where the lines already sit
    expect(row("alias").query).toBe(target.alias);
    expect(row("settled").speaker).toBe(target.main);
    // and a term the book never uses is not the alias by another name
    expect(row("empty").query).not.toBe(target.alias);
  });
});

test("a newly imported book has deterministic source text for the seeded workflow", () => {
  // no `Math.random` stub here: the point is that the text does not depend on one
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  useUiStore().toast = () => "test";
  const imported = useLibraryStore().addNovel("brand-new.epub", "Brand New");
  const first = useScriptsStore().rawText(imported, 1);
  expect(first.length).toBeGreaterThan(100);
  expect(useScriptsStore().rawText(imported, 1)).toBe(first);
});
