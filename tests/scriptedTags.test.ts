// Expression tags the scripting model writes: the marker it is told, how a line's tags are read out
// of its text, and what each voice is sent — in its own bracket, by name from its list, or not at
// all, quietly.
import { describe, expect, test } from "bun:test";

import type { Endpoint, ExpressionConfig, ExpressionTag, TagBracket } from "@/types";
import { expressionNames, expressionPlan, scriptedAnnotation } from "@/lib/expressions";
import {
  BUILT_IN_PROMPT,
  readScriptedTags,
  renderPrompt,
  sampleVars,
  scriptMarkerFor,
  SCRIPT_MARKERS,
} from "@/lib/prompt";

const SQUARE = SCRIPT_MARKERS[0];

describe("the marker", () => {
  test("is [[ ]] unless the excerpt has either half, then the first pair it has neither of", () => {
    expect(scriptMarkerFor("Come in.")).toEqual(["[[", "]]"]);
    expect(scriptMarkerFor("[[System]] Come in.")).toEqual(["<<", ">>"]);
    expect(scriptMarkerFor("a]] and <<b")).toEqual(["{|", "|}"]);
    expect(scriptMarkerFor("[[ << {|")).toBeNull();
  });

  test("is the one the output format names, and the built-in prompt no longer forbids cues", () => {
    const sent = (excerpt: string) =>
      renderPrompt(BUILT_IN_PROMPT, sampleVars(excerpt, { name: "E", model: "m" })).system;
    expect(sent("Come in.")).toContain("as [[sigh]]: plain words between [[ and ]]");
    expect(sent("[[System]] Come in.")).toContain("as <<sigh>>: plain words between << and >>");
    expect(sent("[[ << {|")).not.toContain("Expression tags");
    expect(BUILT_IN_PROMPT.system).not.toContain("[sighs]");
  });

  test("{{expressions}} lists the voices' tag names, and drops its line when there are none", () => {
    const template = { system: "Tags you may use: {{expressions}}", user: "{{excerpt}}" };
    const vars = sampleVars("Come in.", { name: "E", model: "m" });
    expect(renderPrompt(template, { ...vars, expressions: ["sighs", "laughs"] }).system).toMatch(
      /^Tags you may use: sighs, laughs\n/,
    );
    expect(renderPrompt(template, vars).system).not.toContain("Tags you may use");
  });
});

describe("a line's tags, read out of its text", () => {
  test.each([
    ["[[sigh]] I told you, [[laughs]] didn't I?", "I told you, didn't I?", [0, 12]],
    ["Come in [[sigh]].", "Come in.", [7]],
    ["Come in. [[sigh]]", "Come in.", [8]],
    ["you,[[laughs]] didn't", "you, didn't", [4]],
    ["wo[[sigh]]rd", "word", [0]],
    ["Fine. [[sigh]][[laughs]] Go.", "Fine. Go.", [6, 6]],
  ])("%p is %p with tags at %p", (marked, text, ats) => {
    const read = readScriptedTags(marked, SQUARE);
    expect(read.text).toBe(text);
    expect(read.tags.map((t) => t.at)).toEqual(ats);
  });

  test("keeps a tag's words, spaces folded", () => {
    expect(readScriptedTags("[[ laughing  nervously ]] No.", SQUARE).tags).toEqual([
      { label: "laughing nervously", at: 0 },
    ]);
  });

  test("leaves a marker that is not a few plain words, and any other marker, in the text", () => {
    for (const marked of ["Go [[<b>]] now.", "Go [[sigh] now.", "Go <<sigh>> now.", "Go [[]] now."])
      expect(readScriptedTags(marked, SQUARE)).toEqual({ text: marked, tags: [] });
    expect(readScriptedTags("Go [[sigh]] now.", null)).toEqual({
      text: "Go [[sigh]] now.",
      tags: [],
    });
  });
});

describe("what a voice is sent", () => {
  const fish = { baseUrl: "https://api.fish.audio/v1", model: "s2.1-pro" };
  const listed = (token: string, label: string): ExpressionTag => ({
    id: label,
    label,
    token,
    kind: "delivery",
  });
  const voice = (brackets: TagBracket[], open: boolean, ...tags: ExpressionTag[]) =>
    ({
      id: "ep",
      name: "Ep",
      maxChars: 0,
      ...fish,
      expressions: { status: "supported", ...fish, brackets, open, tags } as ExpressionConfig,
    }) as Endpoint;
  const read = readScriptedTags("[[sigh]] I told you, [[laughs]] didn't I?", SQUARE);
  const line = {
    text: read.text,
    expressions: read.tags.map((t, i) => scriptedAnnotation(t, i + 1)),
  };

  test("a model taking any words gets each tag in its own bracket", () => {
    const plan = expressionPlan(line, voice(["square"], true));
    expect(plan.text).toBe("[sigh] I told you, [laughs] didn't I?");
    expect(plan.issues).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  test("a fixed list gets its own tag of that name, whatever its kind, and the rest are left out quietly", () => {
    const plan = expressionPlan(line, voice(["round"], false, listed("(sighs)", "sigh")));
    expect(plan.text).toBe("(sighs) I told you, didn't I?");
    expect(plan.issues).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        annotationId: 2,
        label: "laughs",
        reason: "This expression is not in this model's supported list.",
      },
    ]);
  });

  test("with no voice, or one taking no tags, the line goes as its words, held by nothing", () => {
    for (const ep of [null, voice([], false)]) {
      const plan = expressionPlan(line, ep);
      expect(plan.text).toBe("I told you, didn't I?");
      expect(plan.issues).toEqual([]);
      expect(plan.skipped.map((s) => s.label)).toEqual(["sigh", "laughs"]);
    }
  });

  test("a tag placed by hand that the voice cannot take still asks for review", () => {
    const placed = { ...listed("(sighs)", "sigh"), kind: "sound" as const, at: 0, annotationId: 1 };
    const plan = expressionPlan({ text: "No.", expressions: [placed] }, voice(["square"], false));
    expect(plan.issues.map((i) => i.label)).toEqual(["sigh"]);
    expect(plan.skipped).toEqual([]);
  });
});

test("expressionNames: each confirmed voice's tags, once by name", () => {
  const ep = (status: ExpressionConfig["status"], ...labels: string[]) =>
    ({
      id: status,
      baseUrl: "u",
      model: "m",
      expressions: {
        status,
        baseUrl: "u",
        model: "m",
        brackets: ["square"],
        open: false,
        tags: labels.map((l) => ({
          id: l.toLowerCase(),
          label: l,
          token: `[${l}]`,
          kind: "sound",
        })),
      },
    }) as unknown as Endpoint;
  expect(
    expressionNames([
      ep("supported", "sighs", "laughs"),
      ep("supported", "Laughs", "gasps"),
      ep("unknown", "coughs"),
    ]),
  ).toEqual(["sighs", "Laughs", "gasps"]);
});
