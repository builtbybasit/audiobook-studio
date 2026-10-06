// Expression tags in the brackets a model takes: where each provider's Expressions tab starts (from
// its docs, `src/lib/providers/`), what the tab lets be saved once the brackets are chosen, and what
// a line annotated with a tag is sent as.
import { describe, expect, test } from "bun:test";

import type { Endpoint, ExpressionConfig, ExpressionTag, TagBracket } from "@/types";
import {
  configErrors,
  expressionDefaults,
  expressionPlan,
  tagToken,
  validToken,
  withBrackets,
} from "@/lib/expressions";

const HOSTS = {
  fish: "https://api.fish.audio/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  elevenlabs: "https://api.elevenlabs.io/v1",
  breezeblue: "https://api.breeze.blue/v1",
  minimax: "https://api.minimax.io/v1",
  cartesia: "https://api.cartesia.ai",
  qwen: "https://dashscope-intl.aliyuncs.com/api/v1",
  openai: "https://api.openai.com/v1",
  local: "http://127.0.0.1:8880/v1",
};

const at = (host: keyof typeof HOSTS, model: string) => ({ baseUrl: HOSTS[host], model });

const tag = (token: string, kind: ExpressionTag["kind"] = "sound"): ExpressionTag => ({
  id: token.toLowerCase(),
  label: token,
  token,
  kind,
});

const config = (
  e: { baseUrl: string; model: string },
  brackets: TagBracket[],
  ...tags: ExpressionTag[]
): ExpressionConfig => ({ status: "supported", ...e, brackets, open: false, tags });

describe("where a model's tab starts", () => {
  test.each([
    ["Fish S2", at("fish", "s2.1-pro"), ["square"], true],
    ["Fish S1", at("fish", "s1"), ["round"], false],
    ["Gemini 3.8", at("gemini", "gemini-3.8-flash-tts"), ["angle"], true],
    ["Eleven v3", at("elevenlabs", "eleven_v3"), ["square"], true],
    ["Eleven Multilingual v2", at("elevenlabs", "eleven_multilingual_v2"), ["angle"], false],
    ["BreezeBlue", at("breezeblue", "breeze-tts-2"), ["round", "square"], false],
    ["MiniMax 2.8", at("minimax", "speech-2.8-hd"), ["round", "angle"], false],
    ["MiniMax before 2.8", at("minimax", "speech-02-hd"), ["angle"], false],
    ["Cartesia", at("cartesia", "sonic-3.6"), ["angle", "square"], false],
    ["a local server", at("local", "orpheus"), ["square", "angle", "round"], false],
    ["OpenAI", at("openai", "gpt-4o-mini-tts"), [], false],
    ["Qwen", at("qwen", "qwen-audio-3.0-tts-flash"), [], false],
    ["a Gemini preview", at("gemini", "gemini-3.1-flash-tts-preview"), [], false],
  ])("%s: %p, any words %p", (_, e, brackets, open) => {
    expect(expressionDefaults(e)).toMatchObject({ status: "unknown", brackets, open, tags: [] });
  });

  test("a config saved before brackets were asked for takes the provider's", () => {
    const { brackets: _, open: __, ...old } = config(at("fish", "s2.1-pro"), [], tag("[laughs]"));
    expect(withBrackets(old)).toMatchObject({ brackets: ["square"], open: true });
  });
});

describe("a tag in the chosen brackets", () => {
  test.each([
    ["[laughing nervously]", ["square"], true],
    ["(laughing)", ["square"], false],
    ["(laughing)", ["round", "square"], true],
    ["<#0.5#>", ["angle"], true],
    ['<break time="1.5s" />', ["angle"], true],
    ["[nested [tag]]", ["square"], false],
    ["[ ]", ["square"], false],
    ["laugh", ["square", "angle", "round"], false],
    ["[laughs]", [], false],
  ] as const)("%s in %p: %p", (token, brackets, ok) => {
    expect(validToken(token, brackets)).toBe(ok);
  });

  test("words typed for a tag go in the first bracket chosen, and a bracketed one stays as typed", () => {
    expect(tagToken(" laughing nervously ", ["round", "square"])).toBe("(laughing nervously)");
    expect(tagToken("<sigh>", ["square"])).toBe("<sigh>");
  });
});

describe("what can be saved", () => {
  test("brackets of the person's choosing, even where the provider's docs list none", () => {
    expect(
      configErrors(config(at("openai", "gpt-4o-mini-tts"), ["square"], tag("[laughs]"))),
    ).toEqual([]);
  });

  test("no brackets is saved as a model without tags", () => {
    expect(configErrors({ ...config(at("fish", "s2.1-pro"), []), status: "unsupported" })).toEqual(
      [],
    );
    expect(configErrors(config(at("fish", "s2.1-pro"), []))).toEqual([
      "Choose the brackets this model's tags are written in.",
    ]);
  });

  test("a fixed list needs a tag in it; any words needs none", () => {
    const fixed = config(at("fish", "s2.1-pro"), ["square"]);
    expect(configErrors(fixed)).toEqual(["Add at least one tag, or let any words in."]);
    expect(configErrors({ ...fixed, open: true })).toEqual([]);
  });

  test("a tag outside the chosen brackets is refused with an example in them", () => {
    expect(
      configErrors(config(at("gemini", "gemini-3.8-flash-tts"), ["angle"], tag("[laugh]"))),
    ).toEqual(["Write each tag whole in the chosen brackets, such as <laugh>."]);
  });

  test("Gemini 3.8 takes sounds inline and not a delivery, which goes in its style", () => {
    const errors = configErrors(
      config(at("gemini", "gemini-3.8-flash-tts"), ["angle"], tag("<whispering>", "delivery")),
    );
    expect(errors).toEqual([
      "This model takes only vocal sounds inline; give the rest as the line's direction.",
    ]);
  });
});

describe("a line annotated for a model", () => {
  const endpoint = (e: { baseUrl: string; model: string }, c: ExpressionConfig) =>
    ({ id: "ep", name: "Ep", maxChars: 0, ...e, expressions: c }) as Endpoint;
  const annotated = (t: ExpressionTag) => ({
    text: "Come in.",
    expressions: [{ ...t, at: 0, annotationId: 1 }],
  });
  const gemini = at("gemini", "gemini-3.8-flash-tts");

  test("is sent with the tag as the list spells it", () => {
    const laugh = tag("<laugh>");
    const plan = expressionPlan(
      annotated(laugh),
      endpoint(gemini, config(gemini, ["angle"], laugh)),
    );
    expect(plan.issues).toEqual([]);
    expect(plan.text).toBe("<laugh> Come in.");
  });

  test("on a model set to no tags, asks for review rather than speaking the tag as words", () => {
    const laugh = tag("[laughs]");
    const c = { ...config(gemini, [], laugh), status: "unsupported" as const };
    const plan = expressionPlan(annotated(laugh), endpoint(gemini, c));
    expect(plan.issues.map((i) => i.reason)).toEqual([
      "This model is configured without expression support.",
    ]);
    expect(plan.text).toBe("Come in.");
  });

  test("a typed tag outside the brackets an open model takes asks for review", () => {
    const c = { ...config(gemini, ["angle"]), open: true };
    const plan = expressionPlan(annotated(tag("[sighs]")), endpoint(gemini, c));
    expect(plan.issues.map((i) => i.reason)).toEqual([
      "This tag is not in the brackets this model takes.",
    ]);
  });

  test("a delivery on a model that takes only sounds inline asks for review", () => {
    const whisper = tag("<whispering>", "delivery");
    const plan = expressionPlan(
      annotated(whisper),
      endpoint(gemini, config(gemini, ["angle"], whisper)),
    );
    expect(plan.issues.map((i) => i.reason)).toEqual([
      "This model takes only vocal sounds inline; give the rest as the line's direction.",
    ]);
  });
});
