import { useCastStore } from "../src/stores/cast";
import { useDemoStore } from "../src/stores/demo";
import { useExportsStore } from "../src/stores/exports";
import { useLibraryStore } from "../src/stores/library";
import { useScriptsStore } from "../src/stores/scripts";
import { useUiStore } from "../src/stores/ui";
// The mock world, its fixtures and its demo scenarios.
//
// Two properties matter here and neither is visible from a screenshot. A world is *fresh*: two
// calls to `makeWorld()` share nothing, so editing one book cannot be observed through another, and
// the hand-authored seeds are never written back to. And a scenario is *reversible*: seeding one and
// resetting it puts the book back exactly as it was, so running scenarios one after another gives
// the same result as running any of them first.
//
// The simulated encoder runs on setInterval, so the clock and the timer API are faked.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import {
  BOOK_SEEDS,
  exportDemoPrep,
  exportScenarios,
  makeEndpoints,
  makeLexicon,
  makeProfiles,
  makeWorld,
  searchDemoTarget,
  searchScenarios,
} from "../src/mock";

let callbacks = new Map<number, () => void>();
let clock = 1000;
let restore: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let demoStore: ReturnType<typeof useDemoStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;

function drain(max = 400) {
  for (let i = 0; i < max && callbacks.size; i++)
    for (const [id, fn] of Array.from(callbacks)) if (callbacks.has(id)) fn();
}

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  demoStore = useDemoStore();
  exportsStore = useExportsStore();
  libraryStore = useLibraryStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  uiStore.toast = () => "test";
  callbacks = new Map();
  clock = 1000;
  let seq = 0;
  restore = [
    spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
      const id = ++seq;
      callbacks.set(id, fn);
      return id;
    }) as typeof setInterval),
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      callbacks.delete(id);
    }) as typeof clearInterval),
    spyOn(Date, "now").mockImplementation(() => (clock += 1)),
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((f) => f()));

/** Everything a demo scenario is allowed to touch, digested — the states compared here run to
 *  hundreds of kilobytes, and a failing assertion only needs to say which scenario moved. */
const digest = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16) + ":" + s.length;
};

const bookState = (bookId: string): string =>
  digest(
    JSON.stringify({
      book: libraryStore.bookById(bookId),
      chapters: libraryStore.chaptersOf(bookId),
      characters: castStore.charactersOf(bookId),
      segments: Object.entries(scriptsStore.segments)
        .filter(([k]) => k.startsWith(bookId + ":"))
        .sort(([a], [b]) => a.localeCompare(b)),
      exports: exportsStore.exports
        .filter((e) => e.bookId === bookId)
        .map((e) => e.key + ":" + e.version),
    }),
  );

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
  test("every speaker routes to a voice that exists on an endpoint that exists", () => {
    const w = makeWorld();
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
    const w = makeWorld();
    for (const bookId of Object.keys(w.characters)) {
      const narrator = w.characters[bookId].find((c) => c.name === "Narrator");
      expect(narrator, bookId).toBeDefined();
      expect(narrator!.voice, bookId).toBeTruthy();
    }
  });

  test("chapters, volumes and segments agree", () => {
    const w = makeWorld();
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
    const w = makeWorld();
    for (const [k, segs] of Object.entries(w.segments)) {
      const names = new Set(w.characters[k.split(":")[0]].map((c) => c.name));
      for (const s of segs) expect(names.has(s.speaker), `${k} · ${s.speaker}`).toBe(true);
    }
  });

  test("every finished export names chapters the book still has", () => {
    const w = makeWorld();
    for (const e of w.exports) {
      const ids = new Set(w.chapters[e.bookId].map((c) => c.id));
      for (const id of e.chapterIds) expect(ids.has(id), `${e.filename} ch ${id}`).toBe(true);
    }
  });
});

describe("demo scenarios", () => {
  test("every export scenario seeds and resets back to where it started", () => {
    for (const s of exportScenarios()) {
      const before = bookState(s.bookId);
      const prep = exportDemoPrep(s.id);
      expect(demoStore.seedExportDemo(s.id), s.id).toBe(s.bookId);
      // `mixed` and `update` are the book as it already stands — they only explain what you see
      if (prep.freshen || prep.clearExports || prep.buildHistory)
        expect(bookState(s.bookId), `${s.id} changed nothing`).not.toBe(before);
      demoStore.resetExportDemo();
      drain(); // a cancelled build only notices on its next tick
      expect(bookState(s.bookId), `${s.id} did not reset cleanly`).toBe(before);
    }
  });

  test("a scenario seeded after another is the same as one seeded first", () => {
    demoStore.seedExportDemo("ready");
    const first = bookState("starforge");
    demoStore.resetExportDemo();
    drain();

    // a different scenario on the same book, in and out again
    demoStore.seedExportDemo("builds");
    demoStore.resetExportDemo();
    drain();

    demoStore.seedExportDemo("ready");
    expect(bookState("starforge")).toBe(first);
  });

  test("seeding one book's scenario leaves the other books alone", () => {
    const others = libraryStore.books.filter((b) => b.id !== "gates").map((b) => b.id);
    const before = others.map(bookState);
    demoStore.seedExportDemo("long");
    expect(others.map(bookState)).toEqual(before);
    demoStore.resetExportDemo();
    drain();
  });

  test("the search demo seeds, scatters an alias and resets back", () => {
    const before = bookState("cliche");
    const target = demoStore.searchDemo("cliche")!;
    expect(target).not.toBeNull();

    demoStore.seedSearchDemo("cliche");
    const speakers = new Set(
      libraryStore
        .chaptersOf("cliche")
        .flatMap((c) => scriptsStore.segmentsOf("cliche", c.id).map((s) => s.speaker)),
    );
    expect(speakers.has(target.alias)).toBe(true);
    expect(castStore.charactersOf("cliche").some((c) => c.name === target.alias)).toBe(true);

    demoStore.resetSearchDemo();
    expect(bookState("cliche")).toBe(before);
  });

  test("seeding the search demo twice is a no-op, so reset cannot lose the original", () => {
    const before = bookState("cliche");
    demoStore.seedSearchDemo("cliche");
    const once = bookState("cliche");
    demoStore.seedSearchDemo("cliche");
    expect(bookState("cliche")).toBe(once);
    demoStore.resetSearchDemo();
    expect(bookState("cliche")).toBe(before);
  });

  test("search scenarios are offered only for a book with a script", () => {
    expect(demoStore.searchScenarios("cliche").length).toBe(3);
    const unscripted = libraryStore.addNovel("brand-new.epub", "Brand New");
    expect(demoStore.searchDemo(unscripted)).toBeNull();
    expect(demoStore.searchScenarios(unscripted)).toEqual([]);
  });

  test("a newly imported book has deterministic source text for the seeded workflow", () => {
    const imported = libraryStore.addNovel("brand-new.epub", "Brand New");
    const first = scriptsStore.rawText(imported, 1);
    expect(first.length).toBeGreaterThan(100);
    expect(scriptsStore.rawText(imported, 1)).toBe(first);
  });

  test("the search scenario rows describe the character they were built from", () => {
    const target = searchDemoTarget(castStore.charactersOf("cliche"))!;
    const rows = searchScenarios(target);
    expect(rows.map((r) => r.id)).toEqual(["alias", "settled", "empty"]);
    expect(rows[0].query).toBe(target.alias);
    expect(rows[1].speaker).toBe(target.main);
    expect(rows[2].query).not.toBe(target.alias);
  });
});
