// Filling speakers' blanks from their wiki pages: who is asked, what a page may change, Undo and
// Stop. Stores filled by hand over a fake service, no server.
import { beforeEach, describe, expect, test } from "bun:test";
import { useQueryCache } from "@pinia/colada";
import { narrator, newSpeaker } from "@/lib/cast";
import { newProfile } from "@/lib/scripting";
import { clone } from "@/lib/utils";
import { keys } from "@/queries/keys";
import type { LibraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExistingLinesStore } from "@/stores/existingLines";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";
import type { Book, Character, SpeakerWikiFill } from "@/types";
import { testPinia, type TestPinia } from "./support/pinia";

const speaker = (name: string, extra: Partial<Character> = {}): Character => ({
  ...newSpeaker(name, 0),
  voice: null,
  ...extra,
});
const page = (name: string, fill: SpeakerWikiFill["fill"]): SpeakerWikiFill => ({
  name,
  url: `https://x.fandom.com/wiki/${name}`,
  fill,
  notes: [],
});

let t: TestPinia;
let cast: ReturnType<typeof useCastStore>;
let undo: (() => void) | undefined;
let asked: string[][];
beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  t = testPinia();
  cast = useCastStore();
  useLibraryStore().books = [
    {
      id: "b",
      characterVoice: { by: "gender", one: null, male: "ep/m", female: "ep/f", other: null },
    } as Book,
  ];
  cast.characters.b = [
    narrator("ep/n"),
    speaker("Ana", { gender: "f", age: "teen", voiceType: { pitch: "low" }, major: true }),
    speaker("Bo", { major: true }),
    speaker("Mask", { personaOf: "Ana", major: true }),
    speaker("Hood", { masked: true }),
    speaker("Cy"),
  ];
  cast._service = () =>
    ({ putCharacters: async () => clone(cast.characters.b) }) as unknown as LibraryService;
  asked = [];
  useExistingLinesStore().askVoice = async (_, names) => void asked.push(names);
  undo = undefined;
  useUiStore().toast = (_msg: string, opts?: { undo?: () => void }) => {
    undo = opts?.undo;
    return "test";
  };
});

describe("applying a page", () => {
  test("fills only blanks, gender only while unknown, and asks about a voice it moved", async () => {
    cast.applyWikiFills("b", [
      page("Ana", { gender: "m", age: "child", voiceType: { pitch: "high", texture: "husky" } }),
      page("Bo", { gender: "m", age: "elderly" }),
    ]);
    await cast._castSettled("b");
    const [ana, bo] = ["Ana", "Bo"].map((n) => cast.byName.b.get(n)!);
    expect(ana).toMatchObject({
      gender: "f",
      age: "teen",
      voiceType: { pitch: "low", texture: "husky" },
    });
    expect(bo).toMatchObject({ gender: "m", age: "elderly", wiki: { url: expect.any(String) } });
    // Bo was read in the Narrator's voice, now the male Character voice; Ana's slot never moved
    expect(asked).toEqual([["Bo"]]);
  });

  test("Undo puts back the fields filled and the page", async () => {
    const before = clone(cast.characters.b);
    cast.applyWikiFills("b", [page("Bo", { gender: "m", voiceType: { delivery: ["calm"] } })]);
    undo!();
    await cast._castSettled("b");
    expect(clone(cast.characters.b)).toEqual(before);
  });

  test.each([
    ["a persona", "Mask"],
    ["a masked speaker", "Hood"],
  ])("never fills %s", (_, name) => {
    expect(cast.applyWikiFills("b", [page(name, { gender: "m" })])).toBe(0);
    expect(cast.byName.b.get(name)!.gender).toBe("?");
  });
});

describe("who a fill asks about", () => {
  test.each([
    ["main", undefined, ["Bo", "Ana"], 1],
    ["selected", new Set(["Cy", "Mask", "Narrator"]), ["Cy"], 1],
    ["many", undefined, ["Cy"], 1],
  ] as const)("%s: most lines first, personas and masks skipped", (scope, sel, names, skipped) => {
    t.run(() =>
      useQueryCache().setQueryData(keys.speakerCounts("b"), {
        Ana: { lines: 20 },
        Bo: { lines: 50 },
        Cy: { lines: 400 },
        Mask: { lines: 300 },
        Narrator: { lines: 900 },
      }),
    );
    expect(cast.wikiScope("b", scope, sel)).toEqual({ names: [...names], skipped });
  });
});

describe("asking the wiki", () => {
  test("Stop ends the run after the answer in hand, asking nobody else", async () => {
    useEndpointsStore().profiles = [
      newProfile({ id: "p", name: "p", model: "m", needsKey: false }),
    ];
    const sent: string[] = [];
    const stop = new AbortController();
    cast._service = () =>
      ({
        speakerWiki: async (_: string, ask: { name: string }) => {
          sent.push(ask.name);
          return page(ask.name, {});
        },
      }) as unknown as LibraryService;
    const rows = await cast.wikiFills("b", ["Ana", "Bo", "Cy"], {
      signal: stop.signal,
      onRow: () => stop.abort(),
    });
    expect(sent).toEqual(["Ana"]);
    expect(rows.map((r) => r.name)).toEqual(["Ana"]);
  });
});
