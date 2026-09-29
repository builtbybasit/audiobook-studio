// The reader's one gesture for cutting a line and placing an expression on it: the gaps between
// words. And the endpoint whose model reads expressions, so the gesture has something to place.
import { test, expect, describe } from "bun:test";

import { EXPRESSION_TAGS } from "@/mock/fixtures/endpoints";
import { expressionSupport } from "@/lib/expressions";
import { gapLabel, gapsOf, tokensOf } from "@/lib/gaps";
import { useEndpointsStore } from "@/stores/endpoints";
import { demoServer } from "./support/demoServer";
import { testPinia } from "./support/pinia";

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
  test("Fish's S2 model ships with tags, so a line read by it can be annotated at once", async () => {
    await demoServer();
    testPinia();
    const endpointsStore = useEndpointsStore();
    await endpointsStore.load();
    const ep = endpointsStore.endpoints.find((e) => e.id === "fish")!;
    expect(expressionSupport(ep)).toBe("supported");
    expect(ep.expressions?.tags.map((t) => t.id)).toEqual(EXPRESSION_TAGS.map((t) => t.id));
    expect(EXPRESSION_TAGS.some((t) => t.kind === "sound")).toBe(true);
    expect(EXPRESSION_TAGS.some((t) => t.kind === "delivery")).toBe(true);
  });
});
