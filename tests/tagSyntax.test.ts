// Expression tags in each provider's own syntax: what the Expressions tab lets be saved for an
// endpoint, and what a line annotated with one is sent as. The shapes come from each provider's
// docs (`src/lib/providers/`); a provider that documents none takes none, since a tag it does not
// know is read out as words.
import { describe, expect, test } from "bun:test";

import type { Endpoint, ExpressionConfig, ExpressionTag } from "@/types";
import { configErrors, expressionPlan, validToken } from "@/lib/expressions";
import { tagSyntaxOf } from "@/lib/providers";

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
  ...tags: ExpressionTag[]
): ExpressionConfig => ({ status: "supported", ...e, tags });

describe("the syntax a model takes its tags in", () => {
  test.each([
    ["Fish S2", at("fish", "s2.1-pro"), "[laughing nervously]", "(laughing)"],
    ["Fish S1", at("fish", "s1"), "(laughing)", "[laughing]"],
    ["Gemini 3.8", at("gemini", "gemini-3.8-flash-tts"), "<short pause>", "[laugh]"],
    ["Eleven v3", at("elevenlabs", "eleven_v3"), "[whispers]", "(whispers)"],
    [
      "Eleven Multilingual v2",
      at("elevenlabs", "eleven_multilingual_v2"),
      '<break time="1.5s" />',
      "[whispers]",
    ],
    ["BreezeBlue, in English", at("breezeblue", "breeze-tts-2"), "(sighs)", "<sigh>"],
    ["MiniMax 2.8", at("minimax", "speech-2.8-hd"), "(clear-throat)", "[laughs]"],
    ["MiniMax before 2.8", at("minimax", "speech-02-hd"), "<#0.5#>", "(laughs)"],
    ["Cartesia", at("cartesia", "sonic-3.6"), '<break time="500ms"/>', "(laughs)"],
    ["a local server", at("local", "orpheus"), "<laugh>", "laugh"],
  ])("%s takes %s and not %s", (_, e, takes, refuses) => {
    const syntax = tagSyntaxOf(e);
    expect(validToken(takes, syntax)).toBe(true);
    expect(validToken(refuses, syntax)).toBe(false);
  });

  test.each([
    ["OpenAI", at("openai", "gpt-4o-mini-tts")],
    ["Qwen", at("qwen", "qwen-audio-3.0-tts-flash")],
    ["a Gemini preview", at("gemini", "gemini-3.1-flash-tts-preview")],
  ])("%s takes none, and a list of tags for it cannot be saved", (_, e) => {
    expect(tagSyntaxOf(e)).toBeNull();
    expect(validToken("[laughs]", null)).toBe(false);
    expect(configErrors(config(e, tag("[laughs]")))).toEqual([
      "This model takes no expression tags. Set it to “No expression tags” instead.",
    ]);
    // saying it takes none is still a configuration
    expect(configErrors({ ...config(e), status: "unsupported" })).toEqual([]);
  });
});

describe("a configuration held to its provider's syntax", () => {
  test("a bracketed tag saved for Fish S2 still passes, as it did before tags followed the provider", () => {
    expect(
      configErrors(config(at("fish", "s2.1-pro"), tag("[laughs]"), tag("[softly]", "delivery"))),
    ).toEqual([]);
  });

  test("a tag in another provider's shape is refused with an example of this one's", () => {
    expect(configErrors(config(at("gemini", "gemini-3.8-flash-tts"), tag("[laugh]")))).toEqual([
      "Each expression needs a name and one complete tag, such as <laugh>.",
    ]);
  });

  test("Gemini 3.8 takes sounds inline and not a delivery, which goes in its style", () => {
    const errors = configErrors(
      config(at("gemini", "gemini-3.8-flash-tts"), tag("<whispering>", "delivery")),
    );
    expect(errors).toEqual([
      "This model takes only vocal sounds inline; give the rest as the line's direction.",
    ]);
  });
});

describe("a line annotated for a provider", () => {
  const endpoint = (e: { baseUrl: string; model: string }, ...tags: ExpressionTag[]) =>
    ({ id: "ep", name: "Ep", maxChars: 0, ...e, expressions: config(e, ...tags) }) as Endpoint;
  const annotated = (t: ExpressionTag) => ({
    text: "Come in.",
    expressions: [{ ...t, at: 0, annotationId: 1 }],
  });

  test("is sent with the tag written as that provider spells it", () => {
    const laugh = tag("<laugh>");
    const plan = expressionPlan(
      annotated(laugh),
      endpoint(at("gemini", "gemini-3.8-flash-tts"), laugh),
    );
    expect(plan.issues).toEqual([]);
    expect(plan.text).toBe("<laugh> Come in.");
  });

  test("on a model that takes no tags, asks for review rather than speaking the tag as words", () => {
    const laugh = tag("[laughs]");
    const plan = expressionPlan(annotated(laugh), endpoint(at("openai", "gpt-4o-mini-tts"), laugh));
    expect(plan.issues.map((i) => i.reason)).toEqual(["This model takes no expression tags."]);
    expect(plan.text).toBe("Come in.");
  });

  test("a delivery on a model that takes only sounds inline asks for review", () => {
    const whisper = tag("<whispering>", "delivery");
    const plan = expressionPlan(
      annotated(whisper),
      endpoint(at("gemini", "gemini-3.8-flash-tts"), whisper),
    );
    expect(plan.issues.map((i) => i.reason)).toEqual([
      "This model takes only vocal sounds inline; give the rest as the line's direction.",
    ]);
  });
});
