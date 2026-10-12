// Pauses inside a line: written by the scripting model as `[[pause]]` or `[[long pause]]`, or
// placed by hand; sent as the voice's own pause tag where its provider's docs give one, and
// otherwise as silence between the parts the line is spoken in — which the estimate counts as the
// requests they are.
import { describe, expect, test } from "bun:test";

import type { Endpoint, ExpressionAnnotation } from "@/types";
import {
  expressionParts,
  expressionPlan,
  pauseAnnotation,
  scriptedAnnotation,
} from "@/lib/expressions";
import { plannedSpeechUnits } from "@/lib/narrationCost";
import { tagSyntaxOf } from "@/lib/providers";
import { BUILT_IN_PROMPT, outputFormat, readScriptedTags, SCRIPT_MARKERS } from "@/lib/prompt";
import { prepareReading } from "@/lib/reading";
import { fromFileLine, toFileLine } from "@/lib/scriptFile";
import { DEFAULT_PACING } from "@/lib/speech";
import { fidelity } from "~/providers/chatScripting";

const SQUARE = SCRIPT_MARKERS[0];

const voice = (baseUrl: string, model: string, over: Partial<Endpoint> = {}): Endpoint =>
  ({
    id: "ep",
    name: "Ep",
    baseUrl,
    model,
    maxChars: 0,
    splitAt: "sentence",
    voices: [],
    ...over,
  }) as Endpoint;
const fish = voice("https://api.fish.audio/v1", "s2.1-pro");
const openai = voice("https://api.openai.com/v1", "gpt-4o-mini-tts");

/** A line read out of what the scripting model wrote, as the scripting job keeps it. */
const scripted = (marked: string) => {
  const read = readScriptedTags(marked, SQUARE);
  return { text: read.text, expressions: read.tags.map((t, i) => scriptedAnnotation(t, i + 1)) };
};

describe("written by the scripting model", () => {
  test("[[pause]] and [[long pause]] are pauses of the book's lengths, the rest still tags", () => {
    const line = scripted("I thought [[pause]] maybe [[sigh]] you'd stay. [[long pause]]");
    expect(line.text).toBe("I thought maybe you'd stay.");
    expect(line.expressions).toEqual([
      {
        id: "pause",
        label: "pause",
        token: "",
        kind: "pause",
        annotationId: 1,
        at: 10,
        scripted: true,
      },
      {
        id: "sigh",
        label: "sigh",
        token: "",
        kind: "sound",
        annotationId: 2,
        at: 16,
        scripted: true,
      },
      {
        id: "long pause",
        label: "long pause",
        token: "",
        kind: "pause",
        annotationId: 3,
        at: 27,
        scripted: true,
      },
    ]);
  });

  test("a pause cut into a word goes to the word's start, and is never a word of the excerpt", () => {
    const excerpt = "“I— I never meant it,” she said.";
    const line = scripted("I— I nev[[ Long  Pause ]]er meant it,");
    expect(line.text).toBe("I— I never meant it,");
    expect(line.expressions[0]).toMatchObject({ kind: "pause", id: "long pause", at: 5 });
    expect(fidelity(excerpt, [{ text: line.text }, { text: "she said." }]).ok).toBe(true);
  });

  test("the output format always says how; the built-in prompt says when", () => {
    expect(outputFormat(SQUARE)).toContain("as [[pause]] for a short one or [[long pause]]");
    expect(outputFormat(SCRIPT_MARKERS[1])).toContain("as <<pause>> for a short one");
    expect(BUILT_IN_PROMPT.system).toMatch(/pause inside a line only for a real beat/);
  });
});

describe("what a voice is sent", () => {
  const line = (...pauses: ExpressionAnnotation[]) => ({
    text: "Well. I suppose so.",
    expressions: pauses,
  });
  const short = pauseAnnotation("pause", 6, 1);
  const long = pauseAnnotation("long pause", 6, 1);
  const own = (s: number) => pauseAnnotation("pause", 6, 1, s);

  test.each([
    ["Fish S2", fish, short, "Well. [break] I suppose so."],
    ["Fish S2, long", fish, long, "Well. [long-break] I suppose so."],
    [
      "Fish S1",
      voice("https://api.fish.audio/v1", "s1"),
      own(0.9),
      "Well. (long-break) I suppose so.",
    ],
    [
      "Gemini 3.8",
      voice("https://generativelanguage.googleapis.com/v1beta", "gemini-3.8-flash-tts"),
      own(0.5),
      "Well. <short pause> I suppose so.",
    ],
    [
      "Eleven v2, held to its 3 seconds",
      voice("https://api.elevenlabs.io/v1", "eleven_multilingual_v2"),
      own(4.5),
      'Well. <break time="3s" /> I suppose so.',
    ],
    [
      "MiniMax",
      voice("https://api.minimax.io/v1", "speech-2.6-hd"),
      own(1.25),
      "Well. <#1.25#> I suppose so.",
    ],
    [
      "Cartesia",
      voice("https://api.cartesia.ai", "sonic-3"),
      short,
      'Well. <break time="0.4s"/> I suppose so.',
    ],
    [
      "BreezeBlue, short",
      voice("https://api.breeze.blue/v1", "breeze-tts-2"),
      short,
      "Well. (pause) I suppose so.",
    ],
  ])("%s", (_, ep, pause, text) => {
    const plan = expressionPlan(line(pause), ep, [], DEFAULT_PACING);
    expect(plan.text).toBe(text);
    expect(plan.pauses).toEqual([]);
    expect(plan.issues).toEqual([]);
  });

  test("with no pause tag, or tags switched off, it is silence where the line is cut", () => {
    for (const ep of [
      openai,
      voice("https://api.breeze.blue/v1", "breeze-tts-2"), // a long pause, which its one tag is not
      {
        ...fish,
        expressions: { ...fish, status: "unsupported", brackets: [], open: false, tags: [] },
      },
    ] as Endpoint[]) {
      const plan = expressionPlan(line(long), ep, [], DEFAULT_PACING);
      expect(plan.text).toBe("Well. I suppose so.");
      expect(plan.pauses).toEqual([{ at: 6, seconds: 1 }]);
      expect(plan.issues).toEqual([]);
    }
  });

  test("a pause of the book's length follows the book's pacing, and the signature with it", () => {
    const pacing = { ...DEFAULT_PACING, inlineShort: 0.8 };
    const before = expressionPlan(line(short), fish, [], DEFAULT_PACING);
    const after = expressionPlan(line(short), fish, [], pacing);
    expect(after.text).toBe("Well. [long-break] I suppose so.");
    expect(after.signature).not.toBe(before.signature);
    // one with a length of its own does not move
    expect(expressionPlan(line(own(0.3)), openai, [], pacing).signature).toBe(
      expressionPlan(line(own(0.3)), openai, [], DEFAULT_PACING).signature,
    );
  });

  test("MiniMax takes a pause only between words: at the line's end it is silence", () => {
    const ep = voice("https://api.minimax.io/v1", "speech-2.6-hd");
    const plan = expressionPlan(
      { text: "Gone.", expressions: [pauseAnnotation("pause", 5, 1)] },
      ep,
      [],
      DEFAULT_PACING,
    );
    expect(plan.text).toBe("Gone.");
    expect(plan.pauses).toEqual([{ at: 5, seconds: 0.4 }]);
  });

  test("every provider description with a pause writes one for any length", () => {
    for (const [baseUrl, model] of [
      ["https://api.fish.audio/v1", "s2.1-pro"],
      ["https://api.elevenlabs.io/v1", "eleven_turbo_v2_5"],
      ["https://api.minimax.io/v1", "speech-2.8-hd"],
      ["https://api.cartesia.ai", "sonic-3"],
      ["https://generativelanguage.googleapis.com/v1beta", "gemini-3.8-flash-tts"],
    ])
      for (const s of [0.05, 0.4, 0.7, 1, 2.5, 120])
        expect(tagSyntaxOf({ baseUrl, model })!.pause!(s)).toBeTruthy();
    expect(
      tagSyntaxOf({ baseUrl: "https://api.elevenlabs.io/v1", model: "eleven_v3" })!.pause,
    ).toBeUndefined();
  });
});

describe("spoken in parts with the silence between", () => {
  test("the line is cut at each silent pause, edges and runs of pauses folded together", () => {
    const plan = expressionPlan(
      {
        text: "Wait. Listen. There.",
        expressions: [
          pauseAnnotation("pause", 0, 1),
          pauseAnnotation("pause", 6, 2),
          pauseAnnotation("long pause", 6, 3),
          pauseAnnotation("pause", 20, 4, 2.5),
        ],
      },
      openai,
      [],
      DEFAULT_PACING,
    );
    const parts = expressionParts(plan, openai);
    expect(parts.map((p) => p.text.trim())).toEqual(["Wait.", "Listen. There."]);
    expect(parts.map((p) => [p.before, p.after])).toEqual([
      [0.4, 1.4],
      [undefined, 2.5],
    ]);
  });

  test("each stretch is still cut at max characters, its last part taking the silence", () => {
    const ep = { ...openai, maxChars: 20 };
    const text = "One sentence here. Another one there. And a third.";
    const plan = expressionPlan(
      { text, expressions: [pauseAnnotation("pause", 38, 1)] },
      ep,
      [],
      DEFAULT_PACING,
    );
    const parts = expressionParts(plan, ep);
    expect(parts.map((p) => p.text.trim())).toEqual([
      "One sentence here.",
      "Another one there.",
      "And a third.",
    ]);
    expect(parts.map((p) => p.after)).toEqual([undefined, 0.4, undefined]);
  });

  test("the estimate counts the extra requests; a voice with a pause tag makes none", () => {
    const line = {
      text: "Well. I suppose so.",
      expressions: [pauseAnnotation("pause", 6, 1)],
      direction: "",
    };
    const silent = prepareReading(line, { endpoint: openai }, [], DEFAULT_PACING);
    expect(silent.requests).toBe(2);
    expect(plannedSpeechUnits(silent, openai).requests).toBe(2);
    const tagged = prepareReading(line, { endpoint: fish }, [], DEFAULT_PACING);
    expect(tagged.requests).toBe(1);
  });
});

test("a script file keeps a pause by its word, and its own length beside it", () => {
  const line = toFileLine({
    id: 1,
    type: "narration",
    speaker: "Narrator",
    text: "Then nothing.",
    direction: "",
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
    expressions: [
      { ...pauseAnnotation("long pause", 5, 1), scripted: true },
      pauseAnnotation("pause", 13, 2, 1.5),
    ],
  });
  expect(line.text).toBe("Then {long pause~} nothing.{pause 1.5s}");
  let n = 0;
  const back = fromFileLine(line, 1, [], () => ++n);
  expect(back.expressions).toEqual([
    { ...pauseAnnotation("long pause", 5, 1), scripted: true },
    pauseAnnotation("pause", 13, 2, 1.5),
  ]);
});
