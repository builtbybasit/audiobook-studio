// Provider presets: what "Start from a preset…" fills in on an endpoint's Connection tab.
//
// A preset is a starting point, so what these guard is that every one of them is a configuration
// the app would accept as it stands — a scripting profile its queue can send a chapter to, with a
// rate card the Pricing tab can read — and that applying one hands over a copy: a preset's billing
// or pricing object that became an endpoint's own would be edited by the Pricing tab, and every
// endpoint made from that preset afterwards would start from the edited rates.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { baseRates, effectiveRates, pricingProblems, speechRates } from "@/lib/pricing";
import {
  endpointErrors,
  presetsOf,
  SCRIPTING_PRESETS,
  scriptingPresetById,
  TTS_PRESETS,
  unifyEndpoint,
} from "@/lib/endpoints";
import { isSimulated } from "@/lib/providers";
import { configErrors, expressionSupport } from "@/lib/expressions";
import { newProfile, profileErrors } from "@/lib/scripting";
import { clone } from "@/lib/utils";
import { useEndpointsStore } from "@/stores/endpoints";
import type { Endpoint } from "@/types";
import { testPinia, type TestPinia } from "./support/pinia";

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/;
/** A server of your own, or this one's simulated provider: neither is a hosted account. */
const unhosted = (baseUrl = ""): boolean => LOCAL.test(baseUrl) || isSimulated(baseUrl);

describe("scripting presets", () => {
  test("each makes a profile the scripting queue accepts, with a rate card that reads", () => {
    expect(SCRIPTING_PRESETS.length).toBeGreaterThan(0);
    for (const preset of SCRIPTING_PRESETS) {
      const profile = newProfile(clone(preset.apply));
      // a local server's model is whatever you pulled, so that preset leaves it for you to type
      const expected = preset.apply.model === "" ? ["Enter a model ID."] : [];
      expect({ preset: preset.id, errors: profileErrors(profile) }).toEqual({
        preset: preset.id,
        errors: expected,
      });
      if (profile.pricing)
        expect({ preset: preset.id, problems: pricingProblems(profile.pricing) }).toEqual({
          preset: preset.id,
          problems: [],
        });
    }
  });

  test("a hosted provider needs a key and is priced; a server of your own is neither", () => {
    for (const { id, apply } of SCRIPTING_PRESETS) {
      const local = unhosted(apply.baseUrl);
      expect({ id, needsKey: apply.needsKey }).toEqual({ id, needsKey: !local });
      if (local)
        expect({ id, in: apply.inPrice, out: apply.outPrice }).toEqual({ id, in: 0, out: 0 });
    }
  });

  test("each is listed under a provider, and a provider's presets sit together", () => {
    // the picker makes a heading per group in the order groups first appear, so one split in two
    // would show the same heading twice
    const groups = SCRIPTING_PRESETS.map((p) => p.group);
    expect(groups.every(Boolean)).toBe(true);
    const runs = groups.filter((g, i) => g !== groups[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  test("ids are unique, and each kind finds its own", () => {
    const ids = SCRIPTING_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(presetsOf("scripting")).toBe(SCRIPTING_PRESETS);
    expect(presetsOf("tts")).toBe(TTS_PRESETS);
    expect(scriptingPresetById(ids[0])).toBe(SCRIPTING_PRESETS[0]);
    expect(scriptingPresetById("fish-pro")).toBeUndefined();
  });

  test("a preset's base URL is the root /chat/completions is appended to", () => {
    for (const { id, apply } of SCRIPTING_PRESETS)
      expect({ id, url: apply.baseUrl }).not.toMatchObject({
        url: expect.stringMatching(/chat\/completions/),
      });
  });
});

/** What `preset` charges per million input tokens, and per million output, at `at`. */
function ratesAt(presetId: string, at: number): [number | null, number | null] {
  const profile = newProfile(clone(scriptingPresetById(presetId)!.apply));
  const { components } = effectiveRates(baseRates(profile), profile.pricing!, at);
  return [components.input.rate, components.output.rate];
}

describe("a preset's rate card over time", () => {
  test("DeepSeek is full price in its weekday peak hours (UTC), half price otherwise", () => {
    // Tuesday 29 September 2026
    expect(ratesAt("deepseek-flash", Date.UTC(2026, 8, 29, 2, 30))).toEqual([0.3, 1.2]);
    expect(ratesAt("deepseek-flash", Date.UTC(2026, 8, 29, 8, 0))).toEqual([0.3, 1.2]);
    expect(ratesAt("deepseek-flash", Date.UTC(2026, 8, 29, 5, 0))).toEqual([0.15, 0.6]);
    expect(ratesAt("deepseek-flash", Date.UTC(2026, 8, 29, 12, 0))).toEqual([0.15, 0.6]);
    // Saturday 3 October, inside what would be a peak hour on a weekday
    expect(ratesAt("deepseek-flash", Date.UTC(2026, 9, 3, 2, 30))).toEqual([0.15, 0.6]);
  });

  test("Gemini 3.8 Flash is its 2026 price until the year ends, and double from 2027", () => {
    expect(ratesAt("gemini-flash", Date.UTC(2026, 11, 31, 23, 0))).toEqual([0.75, 3.75]);
    expect(ratesAt("gemini-flash", Date.UTC(2027, 0, 1, 1, 0))).toEqual([1.5, 7.5]);
  });
});

describe("speech presets", () => {
  /** What a TTS preset charges per million input text tokens and output audio tokens at `at`. */
  function speechAt(presetId: string, at: number): [number | null, number | null] {
    const { apply } = TTS_PRESETS.find((p) => p.id === presetId)!;
    const { components } = effectiveRates(speechRates(apply.billing!), apply.pricing!, at);
    return [components.textTokens.rate, components.audioTokens.rate];
  }

  test("Gemini 3.8 Flash and Flash-Lite TTS are half price until 2027, then their cards", () => {
    expect(speechAt("gemini-3.8-flash-tts", Date.UTC(2026, 11, 31, 23, 0))).toEqual([0.5, 9]);
    expect(speechAt("gemini-3.8-flash-tts", Date.UTC(2027, 0, 1, 1, 0))).toEqual([1, 18]);
    expect(speechAt("gemini-3.8-flash-lite-tts", Date.UTC(2026, 11, 31, 23, 0))).toEqual([0.5, 6]);
    expect(speechAt("gemini-3.8-flash-lite-tts", Date.UTC(2027, 0, 1, 1, 0))).toEqual([1, 12]);
  });

  test("each is listed under a provider, and a provider's presets sit together", () => {
    const groups = TTS_PRESETS.map((p) => p.group);
    expect(groups.every(Boolean)).toBe(true);
    const runs = groups.filter((g, i) => g !== groups[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  test("each has a rate card that reads, and ids are unique", () => {
    const ids = TTS_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { id, apply } of TTS_PRESETS)
      if (apply.pricing)
        expect({ id, problems: pricingProblems(apply.pricing) }).toEqual({ id, problems: [] });
  });
});

describe("what a preset says and sets", () => {
  const ALL = [...TTS_PRESETS, ...SCRIPTING_PRESETS];
  const tts = (id: string) => TTS_PRESETS.find((p) => p.id === id)!;

  test("each rate card is read in UTC, whatever the timezone of the machine that loads it", () => {
    for (const { id, apply } of ALL)
      if (apply.pricing)
        expect({ id, timezone: apply.pricing.timezone }).toEqual({ id, timezone: "UTC" });
  });

  test("every priced hosted preset says which day its rates were read", () => {
    for (const { id, note, apply } of ALL) {
      if (unhosted(apply.baseUrl)) continue;
      expect({ id, dated: note?.includes("as published on 28 September 2026") }).toEqual({
        id,
        dated: true,
      });
    }
  });

  test("a preset's seeded tags are ones its own provider takes", () => {
    const seeded = TTS_PRESETS.filter((p) => p.apply.expressions);
    expect(seeded.length).toBeGreaterThan(0);
    for (const p of seeded) expect([p.id, configErrors(p.apply.expressions!)]).toEqual([p.id, []]);
  });

  test("Gemini 3.8's speech presets start with Google's vocal tags, for their own model", () => {
    for (const id of ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]) {
      const endpoint = clone(tts(id).apply) as Endpoint;
      expect(expressionSupport(endpoint)).toBe("supported");
      const tokens = endpoint.expressions!.tags.map((t) => t.token);
      expect(tokens).toEqual(expect.arrayContaining(["<laugh>", "<sigh>", "<short pause>"]));
      expect(tokens.every((t) => /^<[a-z -]+>$/.test(t))).toBe(true);
      expect(endpoint.expressions!.tags.every((t) => t.kind === "sound")).toBe(true);
    }
    // the legacy preview takes no style, and says so
    expect(tts("gemini-tts").note).toContain("neither is sent");
  });

  test("BreezeBlue bills the text alone, not the instructions sent beside it", () => {
    for (const id of ["breeze-tts-2", "breeze-tts-2-multilingual"])
      expect(tts(id).apply.billing!.billsInstructions).toBe(false);
  });

  test("a request stays inside what the model reads and what its answer can carry", () => {
    // gpt-4o-mini-tts reads at most 2,000 input tokens, instructions included
    expect(tts("openai").apply.maxChars).toBeLessThanOrEqual(2000);
    // MiniMax recommends streaming above 3,000 characters, and answers in hex
    for (const id of ["minimax-speech-2.8-hd", "minimax-speech-2.8-turbo"])
      expect(tts(id).apply.maxChars).toBe(3000);
  });

  test("a price is written as money, and Qwen's shared host is said to be going", () => {
    const qwen = tts("qwen-audio-3.0-tts-plus").note!;
    expect(qwen).toContain("$0.20 per 10,000 characters");
    expect(qwen).toContain("maintenance mode on 30 September 2026");
  });

  test("OpenRouter's presets do not claim its prices are the provider's", () => {
    for (const { id, note, group } of SCRIPTING_PRESETS)
      if (group === "OpenRouter") {
        expect({ id, note }).not.toMatchObject({ note: expect.stringContaining("passes") });
        expect({ id, note }).not.toMatchObject({ note: expect.stringContaining("most-used") });
      }
  });
});

describe("the Simulated presets", () => {
  let pinia: TestPinia;
  beforeEach(() => {
    pinia = testPinia();
  });
  afterEach(() => pinia.stop());

  test("make a speech endpoint ready to render as it stands: voices, no key, no charge", () => {
    const ep = useEndpointsStore().addEndpoint("simulated");
    expect(endpointErrors(unifyEndpoint(ep))).toEqual([]);
    expect(isSimulated(ep.baseUrl)).toBe(true);
    expect(ep.voices.length).toBeGreaterThan(0);
    expect(ep).toMatchObject({ needsKey: false, billing: { rate: 0 }, failRate: 0 });
  });

  test("make a scripting profile the queue accepts, with no key and no charge", () => {
    const profile = newProfile(clone(scriptingPresetById("simulated")!.apply));
    expect(profileErrors(profile)).toEqual([]);
    expect(profile).toMatchObject({ needsKey: false, inPrice: 0, outPrice: 0 });
  });

  test("are listed first, under their own heading", () => {
    for (const presets of [TTS_PRESETS, SCRIPTING_PRESETS]) {
      expect(presets[0]).toMatchObject({ id: "simulated", group: "Simulated" });
      expect(presets.filter((p) => p.group === "Simulated")).toHaveLength(1);
    }
  });
});

describe("adding an endpoint from a preset", () => {
  let pinia: TestPinia;
  beforeEach(() => {
    pinia = testPinia();
  });
  afterEach(() => pinia.stop());

  test("hands over a copy, so editing its prices leaves the preset as published", () => {
    const store = useEndpointsStore();
    const before = clone(TTS_PRESETS.find((p) => p.id === "fish-pro")!.apply);
    const ep = store.addEndpoint("fish-pro");
    ep.billing!.rate = 99;
    expect(TTS_PRESETS.find((p) => p.id === "fish-pro")!.apply).toEqual(before);
    expect(store.addEndpoint("fish-pro").billing).toEqual({ unit: "bytes", rate: 15 });
  });
});
