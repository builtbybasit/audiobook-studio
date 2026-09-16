import { useCastStore } from "../src/stores/cast";
import { useDemoStore } from "../src/stores/demo";
import { useEndpointsStore } from "../src/stores/endpoints";
import { useNarrationStore } from "../src/stores/narration";
import { useScriptsStore } from "../src/stores/scripts";
import { useUiStore } from "../src/stores/ui";
// The reader's one gesture for cutting a line and placing an expression on it: the gaps between
// words. And the demo row that puts expressions on a line so the gesture has something to show.
import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { EXPRESSION_TAGS, demoScenario } from "../src/mock";
import { expressionSupport } from "../src/lib/expressions";
import { gapLabel, gapsOf, tokensOf } from "../src/lib/gaps";

describe("the gaps between words", () => {
  const text = "I am not asking. Doctor, sit down.";

  test("tokens keep the whitespace after each word, so they join back into the source", () => {
    const tokens = tokensOf(text);
    expect(tokens.map((t) => t.text).join("")).toBe(text);
    expect(tokens[0]).toMatchObject({ text: "I ", at: 0, strong: false });
  });

  test("a cut is offered only inside the line; a placement at both edges too", () => {
    const cut = gapsOf(text, "split");
    expect(cut[0].at).toBeGreaterThan(0);
    expect(cut.at(-1)!.at).toBeLessThan(text.length);
    const place = gapsOf(text, "place");
    expect(place[0]).toMatchObject({ at: 0, edge: "start" });
    expect(place.at(-1)).toMatchObject({ at: text.length, edge: "end" });
    expect(place.length).toBe(cut.length + 2);
  });

  test("the gap after a sentence end is the strong one", () => {
    const strong = gapsOf(text, "split").filter((g) => g.strong);
    expect(strong).toHaveLength(1);
    expect(text.slice(strong[0].at)).toBe("Doctor, sit down.");
    expect(gapsOf("‘Careful.’ The steps are wet.", "split")[0].strong).toBe(true);
  });

  test("a gap is named by the words that follow it", () => {
    expect(gapLabel(text, 0)).toBe("before the line");
    expect(gapLabel(text, text.length)).toBe("after the line");
    expect(gapLabel(text, 5, 40)).toBe("before “not asking. Doctor, sit down.”");
    expect(gapLabel(text, 5, 10)).toBe("before “not asking…”");
  });
});

describe("expressions placed in a line", () => {
  let restore: (() => void)[] = [];
  beforeEach(() => {
    Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
    setActivePinia(createPinia());
    useUiStore().toast = () => "test";
    restore = [
      spyOn(globalThis, "setInterval").mockImplementation((() => 0) as typeof setInterval),
      spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as typeof setTimeout),
    ].map((s) => () => s.mockRestore());
  });
  afterEach(() => restore.forEach((f) => f()));

  test("the main OpenAI model ships with tags, so a line read by it can be annotated at once", () => {
    const ep = useEndpointsStore().endpoints.find((e) => e.id === "openai")!;
    expect(expressionSupport(ep)).toBe("supported");
    expect(ep.expressions?.tags.map((t) => t.id)).toEqual(EXPRESSION_TAGS.map((t) => t.id));
    expect(EXPRESSION_TAGS.some((t) => t.kind === "sound")).toBe(true);
    expect(EXPRESSION_TAGS.some((t) => t.kind === "delivery")).toBe(true);
  });

  test("the demo row places two sound expressions and one that needs its position again", () => {
    const demoStore = useDemoStore();
    const narrationStore = useNarrationStore();
    const scriptsStore = useScriptsStore();
    const castStore = useCastStore();
    const open = demoStore.applyScenario("expressions");
    expect(open).toMatch(/^\/book\/starforge\/scripting\?ch=\d+&seg=\d+$/);
    const [, ch, seg] = open!.match(/ch=(\d+)&seg=(\d+)/)!.map(Number);
    const segs = scriptsStore.segmentsOf("starforge", ch);
    const a = segs.find((s) => s.id === seg)!;
    expect(a.expressions).toHaveLength(2);
    expect(a.expressions![0]).toMatchObject({ id: "sighs", at: 0 });
    // the line's speaker resolves to the model that has the tags, so nothing on it needs review
    expect(expressionSupport(castStore.effectiveVoice("starforge", a.speaker).endpoint)).toBe(
      "supported",
    );
    expect(narrationStore.expressionRender("starforge", a).issues).toHaveLength(0);
    // the next annotated line asks for its laugh to be placed again
    const b = segs.find((s) => s.id !== a.id && s.expressions?.length)!;
    expect(b.expressions![0].needsReview).toBe(true);
    expect(narrationStore.expressionRender("starforge", b).issues).toHaveLength(1);
    expect(demoScenario("expressions")?.group).toBe("review");
  });
});
