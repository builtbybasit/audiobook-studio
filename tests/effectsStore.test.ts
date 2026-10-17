// The effects store against a server that answers when told to: edits show at once and go out
// coalesced, a refusal is read back over, a removal clears every choice of the effect, and a
// change to a line's sound re-reads the book's old-sound count.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { narrator, newSpeaker } from "@/lib/cast";
import { clone } from "@/lib/utils";
import { useStaleSound } from "@/queries/effects";
import { ApiError } from "@/services/http";
import { setEffectsService, type EffectsService } from "@/services/effects";
import { setLibraryService, type LibraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExistingLinesStore } from "@/stores/existingLines";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import type { Book, Character, Effect, Endpoint, Step, ThoughtChoice } from "@/types";
import { useChoice } from "@/views/cast/effects/choice";
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
      { id: "echo", name: "Echo", chain: gain(1), useWhen: "a voice from far off" },
      { id: "room", name: "Room", chain: gain(2) },
    ],
    thoughts: "echo",
    characters: [
      narrator(),
      { ...newSpeaker("Ana", 1), effect: "echo", thoughts: "room" },
      { ...newSpeaker("Veil", 2), personaOf: "Ana" },
    ],
  };
  calls = { update: [], stale: 0 };
  refuseNext = null;
  hold = null;
  toasts = [];
  const fake: Partial<EffectsService> = {
    list: async () => clone(server.effects),
    libraryThoughts: async () => server.thoughts,
    create: async (body) => {
      refused();
      const e = { id: `e${server.effects.length}`, ...clone(body) };
      server.effects.push(e);
      return clone(e);
    },
    update: async (effect) => {
      calls.update.push(clone(effect));
      if (hold) await hold;
      refused();
      const e = clone(effect);
      server.effects = server.effects.map((x) => (x.id === e.id ? e : x));
      return clone(e);
    },
    remove: async (id) => {
      refused();
      server.effects = server.effects.filter((e) => e.id !== id);
      return id === "room" ? [{ bookId: "b", chapterId: 1, ids: [1], revision: 8 }] : [];
    },
    setLibraryThoughts: async (choice) => {
      refused();
      return (server.thoughts = choice);
    },
    stale: async () => {
      calls.stale++;
      return { lines: 0, unavailable: 0, ready: true, chapters: [] };
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
    // the write is the whole effect, so it keeps what it was not told to change
    expect(calls.update[0]!.useWhen).toBe("a voice from far off");
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
    expect(effects().effects[1]!.useWhen).toBe("a voice from far off");
  });
});

describe("removing", () => {
  test("takes every choice of it here at once, and says whose they were", async () => {
    const scripts = useScriptsStore();
    scripts._install("b", 1, {
      revision: 7,
      segments: [
        {
          id: 1,
          text: "Rain.",
          speaker: "Ana",
          type: "dialogue",
          direction: "",
          effects: ["room"],
          audio: { status: "none", endpoint: null, duration: 0, ms: 0 },
        },
      ],
    });
    const taken = await effects().remove("room");
    // off the line too, at the chapter's new revision, so no later edit writes it back
    expect(scripts.segmentsOf("b", 1)[0]).not.toHaveProperty("effects");
    expect(scripts._revision["b:1"]).toBe(8);
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
    expect(ctx.cast.get("Veil")).toEqual({ personaOf: "Ana" });
    expect(ctx.effects.get("room")!.name).toBe("Room");
  });
});

describe("a voice's speed", () => {
  // an unknown server takes no speed, so a voice's 1.09 is made here
  beforeEach(() => {
    useEndpointsStore().endpoints = [
      {
        id: "studio",
        baseUrl: "http://localhost:8880/v1",
        voices: [{ id: "ash", label: "Ash", gender: "m", speed: 1.09 }],
      } as Endpoint,
    ];
    useCastStore().byName.b!.get("Ana")!.voice = "studio/ash";
  });

  test("is stretched for a speaker without their own, and their persona", () => {
    const ctx = effects().contextFor("b");
    expect(ctx.cast.get("Ana")?.stretched).toBe(1.09);
    expect(ctx.cast.get("Veil")?.stretched).toBe(1.09);
  });

  // asked on the speed the line gets: their own, else their voice's
  test.each([
    ["back to the voice's", 1.2, null, ["Ana now reads at their voice’s speed"]],
    ["to their voice's own pace", undefined, 1, ["Ana now reads at 1×"]],
    ["back to the voice's, which it matched", 1.09, null, []],
  ] as const)(
    "a speaker's own speed changed %s asks about the old sound",
    async (_, own, to, titles) => {
      useCastStore().byName.b!.get("Ana")!.speed = own;
      const asked: unknown[][] = [];
      useExistingLinesStore().askEffect = async (...a) => void asked.push(a);

      expect(await pinia.run(() => useCastStore().setSpeed("b", "Ana", to))).toBe(true);
      expect(server.characters.find((c) => c.name === "Ana")!.speed).toBe(to ?? undefined);
      expect(asked).toEqual(titles.map((t) => ["b", "Ana", [], "none", t]));
    },
  );
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

describe("a line effect's sheet", () => {
  const line = { key: "1:1", speaker: "Ana", text: "", url: "a.wav", duration: 1, baked: false };

  test("plays a line through its speaker's effect, then the line effect, then the thought one", () => {
    const choice = useChoice(
      () => "b",
      () => "line",
      () => "",
    );
    const heard = (type: "dialogue" | "thought") =>
      choice.effectsFor({ ...line, type }, "room").map((e) => e.id);
    expect(heard("dialogue")).toEqual(["echo", "room"]);
    expect(heard("thought")).toEqual(["echo", "room", "room"]);
  });

  test("chooses nothing: no speaker or book is changed", () => {
    const choice = useChoice(
      () => "b",
      () => "line",
      () => "",
    );
    choice.choose("echo");
    expect(choice.current.value).toBe("none");
    expect(choice.changed.value).toBeNull();
    expect(useLibraryStore().books[0]!.thoughts).toBe("room");
  });
});
