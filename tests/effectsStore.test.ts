// The effects store against a server that answers when told to: an edit shows at once and goes out
// behind it, coalesced; a refusal is said and read back over; a duplicate is named and placed; a
// removal clears every choice of the effect here as the server does; and what changes a line's
// sound has the book's old-sound count read again.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { narrator, newSpeaker } from "@/lib/cast";
import { clone } from "@/lib/utils";
import { useStaleSound } from "@/queries/effects";
import { ApiError } from "@/services/http";
import { setEffectsService, type EffectsService } from "@/services/effects";
import { setLibraryService, type LibraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";
import type { Book, Character, Effect, Step, ThoughtChoice } from "@/types";
import { flush, testPinia, type TestPinia } from "./support/pinia";

const gain = (db: number): Step[] => [{ plugin: "Gain", params: { gain_db: db }, on: true }];

let server: { effects: Effect[]; thoughts: ThoughtChoice; characters: Character[] };
let calls: { update: Effect[]; stale: number };
/** the next request of any kind is refused with this */
let refuseNext: ApiError | null;
/** the next update is held until this is resolved */
let hold: Promise<void> | null;
let toasts: string[];
let pinia: TestPinia;

const refused = (): void => {
  const cause = refuseNext;
  refuseNext = null;
  if (cause) throw cause;
};

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  pinia = testPinia();
  server = {
    effects: [
      { id: "echo", name: "Echo", chain: gain(1) },
      { id: "room", name: "Room", chain: gain(2) },
    ],
    thoughts: "echo",
    characters: [narrator(), { ...newSpeaker("Ana", 1), effect: "echo", thoughts: "room" }],
  };
  calls = { update: [], stale: 0 };
  refuseNext = null;
  hold = null;
  toasts = [];
  const fake: Partial<EffectsService> = {
    list: async () => clone(server.effects),
    libraryThoughts: async () => server.thoughts,
    create: async (name, chain) => {
      refused();
      const e = { id: `e${server.effects.length}`, name, chain: clone(chain) };
      server.effects.push(e);
      return clone(e);
    },
    update: async (id, name, chain) => {
      calls.update.push({ id, name, chain: clone(chain) });
      if (hold) await hold;
      refused();
      const e = { id, name, chain: clone(chain) };
      server.effects = server.effects.map((x) => (x.id === id ? e : x));
      return clone(e);
    },
    remove: async (id) => {
      refused();
      server.effects = server.effects.filter((e) => e.id !== id);
    },
    setLibraryThoughts: async (choice) => {
      refused();
      return (server.thoughts = choice);
    },
    stale: async () => {
      calls.stale++;
      return { lines: 0, unavailable: 0 };
    },
  };
  setEffectsService(fake as EffectsService);
  const library: Partial<LibraryService> = {
    putCharacter: async (_bookId, c) => {
      server.characters = [...server.characters.filter((x) => x.name !== c.name), clone(c)];
      return clone(server.characters);
    },
  };
  setLibraryService(library as LibraryService);
  useUiStore().toast = (message) => {
    toasts.push(message);
    return "";
  };
  useEffectsStore()._install(clone(server.effects), server.thoughts);
  useLibraryStore().books = [{ id: "b", thoughts: "room" } as Book];
  useCastStore()._install("b", { characters: clone(server.characters), lexicon: [] });
});
afterEach(() => {
  pinia.stop();
  setEffectsService(null);
  setLibraryService(null);
});

const effects = () => useEffectsStore();
const names = () => effects().effects.map((e) => e.name);

describe("editing an effect", () => {
  test("shows at once, and many edits go out as one write of the last", async () => {
    for (const db of [3, 4, 5]) effects().update("echo", { chain: gain(db) });
    expect(effects().byId.get("echo")!.chain).toEqual(gain(5));
    expect(calls.update).toHaveLength(0);
    await effects().flush();
    expect(calls.update.map((e) => e.chain)).toEqual([gain(5)]);
    expect(server.effects[0]!.chain).toEqual(gain(5));
  });

  test("an edit made while one is out is sent once it lands, and a read meanwhile keeps it", async () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    effects().update("echo", { name: "Echo 1" });
    const first = effects().flush();
    await flush();
    effects().update("echo", { name: "Echo 2" });
    effects()._install(clone(server.effects), server.thoughts);
    expect(effects().byId.get("echo")!.name).toBe("Echo 2");
    hold = null;
    release();
    await first;
    await effects().flush();
    expect(calls.update.map((e) => e.name)).toEqual(["Echo 1", "Echo 2"]);
    expect(server.effects[0]!.name).toBe("Echo 2");
  });

  test("a refused edit is said, and the server's effect read back over it", async () => {
    refuseNext = new ApiError("Name required", 400);
    pinia.run(() => effects().update("echo", { name: "" }));
    await pinia.run(() => effects().flush());
    await flush();
    expect(toasts).toEqual(["Name required"]);
    expect(effects().byId.get("echo")!.name).toBe("Echo");
  });
});

describe("duplicating", () => {
  test("names the copy, numbering from 2 only when taken, and places it after the original", async () => {
    await effects().duplicate("echo");
    expect(names()).toEqual(["Echo", "Echo Duplicated", "Room"]);
    await effects().duplicate("echo");
    expect(names()).toEqual(["Echo", "Echo Duplicated (2)", "Echo Duplicated", "Room"]);
    expect(effects().effects[1]!.chain).toEqual(gain(1));
  });
});

describe("removing", () => {
  test("takes every choice of it here at once, and says whose they were", async () => {
    const taken = await effects().remove("room");
    expect(taken).toMatchObject({
      library: false,
      books: ["b"],
      speakers: [{ bookId: "b", name: "Ana", effect: false, thoughts: true }],
    });
    expect(names()).toEqual(["Echo"]);
    expect(useLibraryStore().bookById("b")!.thoughts).toBeUndefined();
    const ana = useCastStore()
      .charactersOf("b")
      .find((c) => c.name === "Ana")!;
    expect([ana.effect, ana.thoughts]).toEqual(["echo", undefined]);
    // the library's own choice goes to none, not to another effect
    expect((await effects().remove("echo"))!.library).toBe(true);
    expect(effects().libraryThoughts).toBe("none");
  });

  test("refused, the effect is read back", async () => {
    refuseNext = new ApiError("No such effect", 404);
    expect(await pinia.run(() => effects().remove("room"))).toBeNull();
    expect(toasts).toEqual(["No such effect"]);
    expect(names()).toEqual(["Echo", "Room"]);
  });
});

describe("the library's thought effect", () => {
  test("refused, it goes back to what the server holds", async () => {
    refuseNext = new ApiError("No such effect", 400);
    expect(await pinia.run(() => effects().setLibraryThoughts("room"))).toBe(false);
    expect(effects().libraryThoughts).toBe("echo");
  });

  test("feeds a line's effects through contextFor", () => {
    const ctx = effects().contextFor("b");
    expect([ctx.library, ctx.book]).toEqual(["echo", "room"]);
    expect(ctx.cast.get("Ana")).toEqual({ effect: "echo", thoughts: "room" });
    expect(ctx.effects.get("room")!.name).toBe("Room");
  });
});

describe("the old-sound count", () => {
  test("is read again when the library's thought effect, an effect or a speaker's changes", async () => {
    pinia.run(() => useStaleSound("b"));
    await flush();
    expect(calls.stale).toBe(1);
    await pinia.run(() => effects().setLibraryThoughts("none"));
    await flush();
    expect(calls.stale).toBe(2);
    pinia.run(() => effects().update("echo", { chain: gain(9) }));
    await pinia.run(() => effects().flush());
    await flush();
    expect(calls.stale).toBe(3);
    await pinia.run(() => useCastStore().setEffect("b", "Ana", null));
    await flush();
    expect(calls.stale).toBe(4);
    expect(server.characters.find((c) => c.name === "Ana")!.effect).toBeUndefined();
  });
});
