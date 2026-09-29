import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useNarrationStore } from "@/stores/narration";
import { useUiStore } from "@/stores/ui";
import type { Segment } from "@/types";
import { demoServer } from "./support/demoServer";
import { testPinia, type TestPinia } from "./support/pinia";

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
});

test("a saved expression renderer keeps reading its own stores after another Pinia becomes active", () => {
  const segment: Segment = {
    id: 1,
    type: "dialogue",
    speaker: "Mara",
    text: "Careful on the steps.",
    direction: "",
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  };
  const first = createPinia();
  useCastStore(first).lexicon.b1 = [];
  const render = useNarrationStore(first).expressionRender;
  const before = render("b1", segment);
  const second = createPinia();
  useCastStore(second).lexicon.b1 = [
    { id: 999, term: "Careful", say: "DIFFERENT", enabled: true, matchCase: false },
  ];
  setActivePinia(second);
  expect(render("b1", segment)).toEqual(before);
});

describe("automatic voice assignment", () => {
  let pinia: TestPinia;
  beforeEach(async () => {
    await demoServer();
    pinia = testPinia();
  });
  afterEach(() => pinia.stop());

  test("previews the exact change and undoes it as one action", async () => {
    const cast = useCastStore();
    const ui = useUiStore();
    await useEndpointsStore().load();
    cast._install("starforge", await libraryService().cast("starforge"));
    const voices = () =>
      cast.charactersOf("starforge").map((c) => ({ name: c.name, voice: c.voice }));
    const before = voices();
    const plan = cast.autoAssignPlan("starforge");
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((row) => row.name !== "Narrator" && row.voice.includes("/"))).toBe(true);

    let undo: (() => void) | undefined;
    ui.toast = (_message, options = {}) => {
      undo = options.undo ?? undefined;
      return "test";
    };
    expect(cast.autoAssignByGender("starforge")).toBe(plan.length);
    const voiceOf = (name: string) => cast.charactersOf("starforge").find((c) => c.name === name);
    for (const row of plan) expect(voiceOf(row.name)?.voice).toBe(row.voice);
    for (const row of before.filter((c) => c.voice))
      expect(voiceOf(row.name)?.voice).toBe(row.voice);

    undo!();
    expect(voices()).toEqual(before);
  });
});

test("a book remembers the chapter it is open on, and forgets one it no longer has", () => {
  const uiStore = useUiStore();
  const chapters = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

  // nothing opened yet: every stage falls back to its own pick
  expect(uiStore.chapterIn("cliche", chapters)).toBeNull();

  uiStore.openChapter("cliche", chapters[2].id);
  expect(uiStore.chapterIn("cliche", chapters)).toBe(chapters[2].id);
  // one book's place is not another's
  expect(uiStore.chapterIn("drowned", chapters)).toBeNull();

  // a re-import can take the chapter away; the stages must not open a chapter that isn't there
  expect(
    uiStore.chapterIn(
      "cliche",
      chapters.filter((c) => c.id !== chapters[2].id),
    ),
  ).toBeNull();
});
