// A book's cast and dictionary writes, against a server that answers when told to: they go out one
// at a time in the order made, an older answer never puts back a newer edit, and a read landing
// while an edit is on its way is put off rather than installed over it.
import { isRef, toRaw } from "vue";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { narrator, newSpeaker } from "@/lib/cast";
import { clone } from "@/lib/utils";
import { fetchCast } from "@/queries/cast";
import { setLibraryService, type LibraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import type { Character, LexEntry } from "@/types";
import { flush, testPinia, type TestPinia } from "./support/pinia";

/** What the server holds, and the requests it has been told to hold back, in the order made. */
let server: { characters: Character[]; lexicon: LexEntry[] };
let holds: Promise<void>[];
/** reads of the cast held back after the server has answered them, in the order made */
let readHolds: Promise<void>[];
let pinia: TestPinia;

/** Hold the next write the server is sent until the returned function is called. */
function holdNext(queue = holds): () => void {
  let release!: () => void;
  queue.push(new Promise<void>((r) => (release = r)));
  return release;
}

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  pinia = testPinia();
  server = { characters: [narrator(), newSpeaker("Ana", 1)], lexicon: [] };
  holds = [];
  readHolds = [];
  const fake: Partial<LibraryService> = {
    cast: async () => {
      const read = clone(server);
      await readHolds.shift();
      return read;
    },
    putCharacter: async (_bookId, c) => {
      await holds.shift();
      server.characters = [...server.characters.filter((x) => x.name !== c.name), clone(c)];
      return clone(server.characters);
    },
    putLexicon: async (_bookId, entries) => {
      await holds.shift();
      server.lexicon = clone(entries);
      return { entries: clone(entries), stale: [], restored: [] };
    },
  };
  setLibraryService(fake as LibraryService);
  useCastStore()._install("b", clone(server));
});
afterEach(() => {
  pinia.stop();
  setLibraryService(null);
});

const ana = () =>
  useCastStore()
    .charactersOf("b")
    .find((c) => c.name === "Ana")!;

describe("cast writes", () => {
  test("two edits of one speaker, the first answered last: server and page keep the newer", async () => {
    const cast = useCastStore();
    const release = holdNext();
    const first = cast.updateCharacter("b", "Ana", { style: "first" });
    const second = cast.updateCharacter("b", "Ana", { style: "second" });
    await flush();
    release();
    await Promise.all([first, second, cast._castSettled("b")]);
    expect(server.characters.find((c) => c.name === "Ana")!.style).toBe("second");
    expect(ana().style).toBe("second");
  });

  test("a read landing while an edit is on its way does not put the old speaker back", async () => {
    const cast = useCastStore();
    const release = holdNext();
    ana().style = "edited";
    const pushed = cast._push("b", "Ana");
    // the server still has the old one, and a read of it lands before the edit's answer
    await pinia.run(() => fetchCast("b"));
    expect(ana().style).toBe("edited");
    release();
    expect(await pushed).toBe(true);
    await cast._castSettled("b");
    expect(ana().style).toBe("edited");
  });

  test("a read the server answered before an edit landed, arriving after it, is not installed", async () => {
    const cast = useCastStore();
    const releaseRead = holdNext(readHolds);
    const read = pinia.run(() => fetchCast("b"));
    await flush();
    ana().style = "edited";
    expect(await cast._push("b", "Ana")).toBe(true);
    await cast._castSettled("b");
    // the read was answered with the old speaker, and lands now that nothing is on its way
    releaseRead();
    await read;
    await cast._castSettled("b");
    expect(ana().style).toBe("edited");
  });

  test("a speaker added or changed for another store is written in the same step", async () => {
    const cast = useCastStore();
    const release = holdNext();
    const first = cast.updateCharacter("b", "Ana", { style: "first" });
    // made while that write is out: its answer, which lacks them, must not take them off
    const added = cast._addSpeaker("b", newSpeaker("Bo", 2));
    const patched = cast._patchSpeaker("b", "Ana", { description: "tall" });
    await flush();
    release();
    await first;
    expect(cast.charactersOf("b").map((c) => c.name)).toContain("Bo");
    expect(ana().description).toBe("tall");
    expect([await added, await patched]).toEqual([true, true]);
    await cast._castSettled("b");
    expect(server.characters.map((c) => c.name)).toContain("Bo");
    expect(server.characters.find((c) => c.name === "Ana")!.description).toBe("tall");
  });

  test("a refused speaker resolves false, with the server's cast read back over the edit", async () => {
    const cast = useCastStore();
    const said: string[] = [];
    useUiStore().toast = (message) => {
      said.push(message);
      return "";
    };
    setLibraryService({
      cast: async () => clone(server),
      putCharacter: async () => {
        throw new Error("down");
      },
    } as Partial<LibraryService> as LibraryService);
    const pushed = pinia.run(() => cast.updateCharacter("b", "Ana", { style: "lost" }));
    await pushed;
    expect(ana().style).toBe("");
    expect(said).toEqual(["Could not save this speaker"]);
    expect(await cast._push("b", "Ana")).toBe(false);
  });
});

describe("dictionary writes", () => {
  test("two changes, the first answered last: server and page keep the newer list", async () => {
    const cast = useCastStore();
    const release = holdNext();
    cast.lexicon.b = [{ id: 1, term: "Ana", say: "Ah-na", enabled: true }];
    const first = cast._pushLexicon("b");
    cast.lexicon.b[0].say = "Ann-a";
    const second = cast._pushLexicon("b");
    await flush();
    release();
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    await cast._castSettled("b");
    expect(server.lexicon[0].say).toBe("Ann-a");
    expect(cast.lexiconOf("b")[0].say).toBe("Ann-a");
  });
});

/**
 * Hand every action of `store` a fresh proxy of it as `this`, the way Pinia's devtools do in
 * development — a write queue that keys its state by `this` starts over on each call there.
 */
function proxiedAsDevtools<S extends object>(store: S): void {
  const s = store as Record<string, unknown>;
  const raw = toRaw(store) as Record<string, unknown>;
  for (const name of Object.keys(s)) {
    const action = s[name];
    // a getter that returns a function is a computed underneath, not an action
    if (typeof action !== "function" || name.startsWith("$") || isRef(raw[name])) continue;
    s[name] = function (...args: unknown[]) {
      return (action as (...a: unknown[]) => unknown).apply(new Proxy(store, {}), args);
    };
  }
}

describe("under development's devtools, where each action gets a fresh `this`", () => {
  test("a book's cast writes still queue behind each other", async () => {
    const cast = useCastStore();
    proxiedAsDevtools(cast);
    const release = holdNext();
    const first = cast.updateCharacter("b", "Ana", { style: "first" });
    const second = cast.updateCharacter("b", "Ana", { style: "second" });
    await flush();
    release();
    await Promise.all([first, second, cast._castSettled("b")]);
    expect(server.characters.find((c) => c.name === "Ana")!.style).toBe("second");
    expect(ana().style).toBe("second");
  });

  test("a chapter save is still answered once its write lands", async () => {
    let writes = 0;
    setLibraryService({
      editScript: async (_b: string, _c: number, edit: { segments: unknown[] }) => {
        writes++;
        return {
          revision: writes,
          segments: edit.segments,
          history: { versions: [], head: null, nextId: 1 },
        };
      },
    } as unknown as LibraryService);
    const scripts = useScriptsStore();
    proxiedAsDevtools(scripts);
    scripts.segments["b:1"] = [
      { id: 1, speaker: "Ana", type: "dialogue", text: "Hello." },
    ] as never;
    expect(await scripts._save("b", 1)).toBe(true);
    expect(writes).toBe(1);
  });
});
