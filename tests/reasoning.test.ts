import { describe, expect, test } from "bun:test";

import { reasoningRequest } from "@/lib/reasoning";
import { SIMULATED_BASE_URL } from "@/lib/providers";

const NOTHING = { fields: {}, note: null, omitTemperature: false };

describe("reasoningRequest", () => {
  test("sends nothing without a level, or to the simulated provider", () => {
    expect(reasoningRequest("https://openrouter.ai/api/v1", null)).toEqual(NOTHING);
    expect(reasoningRequest("http://localhost:8000/v1", undefined)).toEqual(NOTHING);
    expect(reasoningRequest(SIMULATED_BASE_URL, "high")).toEqual(NOTHING);
  });

  test("without a level, still leaves temperature out where the host refuses it at any level", () => {
    for (const url of ["https://api.openai.com/v1", "https://api.anthropic.com/v1"])
      expect(reasoningRequest(url, null)).toEqual({ ...NOTHING, omitTemperature: true });
  });

  // [base URL, effort, fields, a note?, temperature left out]
  const cases: [string, "off" | "low" | "medium" | "high", object, boolean, boolean][] = [
    ["https://api.openai.com/v1", "off", { reasoning_effort: "none" }, true, false],
    ["https://api.openai.com/v1", "medium", { reasoning_effort: "medium" }, false, true],
    ["https://openrouter.ai/api/v1", "off", { reasoning: { effort: "none" } }, true, false],
    ["https://openrouter.ai/api/v1", "high", { reasoning: { effort: "high" } }, false, false],
    ["https://api.deepseek.com", "off", { thinking: { type: "disabled" } }, false, false],
    ["https://api.deepseek.com", "medium", { reasoning_effort: "high" }, true, true],
    ["https://api.deepseek.com", "low", { reasoning_effort: "low" }, false, true],
    [
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "off",
      { reasoning_effort: "low" },
      true,
      false,
    ],
    [
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "high",
      { reasoning_effort: "high" },
      false,
      false,
    ],
    ["https://api.anthropic.com/v1", "off", { thinking: { type: "disabled" } }, true, true],
    ["https://api.anthropic.com/v1", "low", {}, true, true],
    ["https://api.x.ai/v1", "off", { reasoning_effort: "low" }, true, false],
    ["https://api.x.ai/v1", "medium", { reasoning_effort: "medium" }, false, false],
    ["http://localhost:11434/v1", "off", { reasoning_effort: "none" }, true, false],
    ["http://127.0.0.1:1234/v1", "off", { reasoning_effort: "low" }, true, false],
    ["http://localhost:8000/v1", "off", { reasoning_effort: "none" }, true, false],
    ["https://my-gateway.example/v1", "high", { reasoning_effort: "high" }, true, false],
  ];
  test.each(cases)("%s at %s", (baseUrl, effort, fields, noted, omitTemperature) => {
    const out = reasoningRequest(baseUrl, effort);
    expect(out.fields).toEqual(fields as Record<string, unknown>);
    expect(out.note !== null).toBe(noted);
    expect(out.omitTemperature).toBe(omitTemperature);
  });

  test("says what was sent instead when the host can't do what was asked", () => {
    expect(
      reasoningRequest("https://generativelanguage.googleapis.com/v1beta/openai", "off").note,
    ).toBe("Gemini 3 models can't turn reasoning off; it is sent as low.");
    expect(reasoningRequest("https://gateway.example/v1", "low").note).toMatch(/reasoning_effort/);
  });
});
