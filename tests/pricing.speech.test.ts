import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import {
  billableChars,
  billingProblems,
  effectiveRates,
  ensurePricing,
  estimateSpeech,
  measureSpeech,
  newPricing,
  normalizeSpeechUsage,
  normalizeUsage,
  priceRequest,
  priceSpeechRequest,
  pricingWarnings,
  promotionRunning,
  speechChargeLines,
  speechComponents,
  speechRates,
  speechWhy,
  switchBillingUnit,
  tokenChargeLines,
  utf8Bytes,
} from "@/lib/pricing";
import { localTimezone } from "@/lib/wallClock";
import { TTS_PRESETS, billingOf, endpointErrors, unifyEndpoint } from "@/lib/endpoints";
import { makeEndpoints } from "@/mock/fixtures/endpoints";
import { useEndpointsStore } from "@/stores/endpoints";
import type { Endpoint, TtsBilling } from "@/types";
import { THU, card, config, promo, u, utc } from "./support/pricingFixtures";

/** A speech endpoint that is valid apart from whatever a test puts on its rate card. */
const ttsEndpointForPricing = (): Endpoint => ({
  id: "t1",
  name: "Test TTS",
  baseUrl: "https://example.test/v1",
  model: "tts-1",
  concurrency: 2,
  enabled: true,
  latency: 1000,
  failRate: 0,
  price: 10,
  needsKey: false,
  maxChars: 500,
  splitAt: "sentence",
  voices: [{ id: "alloy", gender: "n", label: "alloy" }],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
  billing: { unit: "chars", rate: 10 },
  pricing: newPricing({ timezone: "UTC" }),
});

const speechCard = (over: Partial<TtsBilling> = {}): TtsBilling => ({
  unit: "chars",
  rate: 12,
  ...over,
});

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
});

describe("speech endpoints", () => {
  test("a speech rate goes through the same schedule and the same promotions as a token rate", () => {
    const cfg = config({
      windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 40 }],
      promotions: [promo({ scope: ["model"], percent: 20 })],
    });
    // outside the window: only the promotion
    const day = effectiveRates(speechRates(speechCard()), cfg, utc(THU, "12:00")).components.speech;
    expect(day.base).toBe(12);
    expect(day.scheduled).toBe(12);
    expect(day.rate).toBeCloseTo(9.6, 12);

    // inside it: the schedule first, then the promotion on what it left — never compounded off base
    const night = effectiveRates(speechRates(speechCard()), cfg, utc(THU, "23:00")).components
      .speech;
    expect(night.scheduled).toBeCloseTo(7.2, 12);
    expect(night.rate).toBeCloseTo(5.76, 12);
    expect(night.why).toHaveLength(2);
  });

  test("a speech promotion scoped to a token component does nothing, and says so", () => {
    const cfg = config({ promotions: [promo({ scope: ["output"], percent: 50 })] });
    const at = utc(THU, "12:00");
    const base = speechRates(speechCard());
    expect(effectiveRates(base, cfg, at).components.speech.rate).toBe(12);
    expect(pricingWarnings(base, cfg, at).join(" ")).toContain(
      "applies to nothing this endpoint prices",
    );
  });

  test("a discount on a rate nobody knows is still a rate nobody knows", () => {
    const cfg = config({
      windows: [{ id: "n", label: "Night", days: [], from: 0, to: 1439, percent: 30 }],
      promotions: [promo({ percent: 50 })],
    });
    const at = utc(THU, "12:00");
    const snapshot = effectiveRates(speechRates(speechCard({ rate: null })), cfg, at);
    expect(snapshot.components.speech.rate).toBeNull();
    expect(snapshot.components.speech.why).toEqual([]);
    expect(snapshot.applied).toEqual([]);

    const charge = priceSpeechRequest(
      speechCard({ rate: null }),
      cfg,
      u({ chars: 5000, audioSeconds: 60 }),
      { at },
    );
    expect(charge.amount).toBeNull();
    expect(charge.basis).toBe("unknown");
    expect(charge.unknowns.join(" ")).toContain("floor");
  });

  test("a clip is charged in the unit its endpoint bills by, at the rate in force when it landed", () => {
    const cfg = config({
      windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 50 }],
    });
    const measured = u({ chars: 1_000_000, audioSeconds: 600, requests: 3 });

    const perChar = priceSpeechRequest(speechCard({ unit: "chars", rate: 12 }), cfg, measured, {
      at: utc(THU, "23:00"),
    });
    expect(perChar.lines[0].rate).toBe(6);
    expect(perChar.amount).toBeCloseTo(6, 12);
    expect(perChar.unit).toBe("chars");

    // per audio minute: the text length is irrelevant, the duration is not
    const perMinute = priceSpeechRequest(speechCard({ unit: "minute", rate: 0.3 }), cfg, measured, {
      at: utc(THU, "23:00"),
    });
    expect(perMinute.amount).toBeCloseTo((600 / 60) * 0.15, 12);

    // a flat fee per call is charged for every piece a split line became
    const perRequest = priceSpeechRequest(
      speechCard({ unit: "request", rate: 0.02 }),
      cfg,
      measured,
      {
        at: utc(THU, "23:00"),
      },
    );
    expect(perRequest.amount).toBeCloseTo(0.01 * 3, 12);

    // and outside the window the same clip costs the card rate
    expect(
      priceSpeechRequest(speechCard({ unit: "chars", rate: 12 }), cfg, measured, {
        at: utc(THU, "12:00"),
      }).amount,
    ).toBeCloseTo(12, 12);
  });

  test("a clip that failed is charged for what it sent, not for audio it never produced", () => {
    const at = utc(THU, "12:00");
    const failed = u({ chars: 1_000_000, audioSeconds: 0, requests: 1 });
    expect(
      priceSpeechRequest(speechCard({ unit: "chars", rate: 12 }), config(), failed, { at }).amount,
    ).toBeCloseTo(12, 12);
    expect(
      priceSpeechRequest(speechCard({ unit: "minute", rate: 0.3 }), config(), failed, { at })
        .amount,
    ).toBe(0);
  });

  test("a speech receipt keeps its rate when the card changes afterwards", () => {
    const cfg = config({ promotions: [promo({ percent: 50 })] });
    const receipt = priceSpeechRequest(
      speechCard(),
      cfg,
      u({ chars: 1_000_000, audioSeconds: 60 }),
      {
        at: utc(THU, "12:00"),
      },
    );
    expect(receipt.amount).toBeCloseTo(6, 12);
    cfg.promotions = [];
    expect(receipt.amount).toBeCloseTo(6, 12);
    expect(receipt.lines[0].rate).toBe(6);
    expect(receipt.lines[0].base).toBe(12);
    expect(speechWhy(receipt).join(" ")).toContain("P");
  });

  test("a speech estimate offers the undiscounted figure a budget has to use", () => {
    const cfg = config({ promotions: [promo({ percent: 75 })] });
    const e = estimateSpeech(
      speechCard(),
      cfg,
      { chars: 1_000_000, audioSeconds: 600, requests: 4 },
      utc(THU, "12:00"),
    );
    expect(e.cost).toBeCloseTo(3, 12);
    expect(e.withoutPromotions).toBeCloseTo(12, 12);
    expect(e.cautions.join(" ")).toContain("Budget checks use");
  });

  test("both kinds of receipt render through the same charge lines", () => {
    const usage = normalizeUsage(
      {
        prompt_tokens: 10_000,
        completion_tokens: 2_000,
        prompt_tokens_details: { cached_tokens: 8_000 },
      },
      "openai",
    );
    const tokens = tokenChargeLines(
      priceRequest(card({ cachedInput: 0.25 }), config(), usage, { at: utc(THU, "12:00") }),
    );
    expect(tokens.map((l) => l.label)).toEqual(["Input", "Cached input", "Output"]);
    expect(tokens[0].quantity).toBe("2,000 tokens");
    expect(tokens[0].rate).toBe("$1.00 / 1M tokens");

    const speech = speechChargeLines(
      priceSpeechRequest(
        speechCard({ unit: "minute", rate: 0.3 }),
        config(),
        {
          chars: 1240,
          audioSeconds: 90,
        },
        { at: utc(THU, "12:00") },
      ),
    );
    expect(speech).toHaveLength(1);
    expect(speech[0].quantity).toBe("1.50 audio minutes");
    expect(speech[0].rate).toBe("$0.30 / audio min");
    // the two shapes agree on what a line is, which is what lets one table render both
    expect(Object.keys(speech[0]).every((k) => k in tokens[0] || k === "note")).toBe(true);
  });

  test("the seeded speech endpoints cover the discount cases too", () => {
    const store = useEndpointsStore();
    const byId = (id: string) => store.endpoints.find((e) => e.id === id)!;
    // a nightly window that runs past midnight, and a promotion on top of it
    expect(byId("openai").pricing!.windows.some((w) => w.to <= w.from)).toBe(true);
    expect(byId("openai").pricing!.promotions.some((p) => promotionRunning(p, Date.now()))).toBe(
      true,
    );
    // a free local model with no advanced pricing at all — the block is absent until something asks
    // for it, and asking gives it an empty schedule and no promotions, which is "ordinary pricing"
    expect(byId("local").pricing).toBeUndefined();
    expect(ensurePricing(byId("local"))).toEqual({
      cachedInput: null,
      cacheWrite: null,
      timezone: localTimezone(),
      windows: [],
      promotions: [],
    });
    // and one whose rate is unknown, where the window it has changes nothing
    const proxy = byId("proxy");
    expect(proxy.billing!.rate).toBeNull();
    expect(proxy.pricing!.windows.length).toBeGreaterThan(0);
    expect(
      effectiveRates(speechRates(proxy.billing!), proxy.pricing!, Date.now()).components.speech
        .rate,
    ).toBeNull();
  });
});

describe("a speech rate is not quoted per million of anything", () => {
  test("a schedule's reason is written in the unit the endpoint actually bills in", () => {
    const perMinute: TtsBilling = { unit: "minute", rate: 0.9 };
    const cfg = config({
      windows: [{ id: "n", label: "Night", days: [], from: 0, to: 1439, rates: { speech: 0.4 } }],
    });
    const charge = priceSpeechRequest(perMinute, cfg, u({ chars: 1000, audioSeconds: 60 }), {
      at: utc(THU, "12:00"),
    });
    expect(speechWhy(charge).join(" ")).toContain("/ audio min");
    expect(speechWhy(charge).join(" ")).not.toContain("/ 1M");

    // the token side is unchanged: those really are per million tokens
    const tokens = effectiveRates(
      card(),
      config({
        windows: [{ id: "n", label: "Night", days: [], from: 0, to: 1439, rates: { input: 0.4 } }],
      }),
      utc(THU, "12:00"),
    );
    expect(tokens.components.input.why.join(" ")).toContain("/ 1M tokens");
  });

  test("a promotion that names an explicit speech rate quotes it in the same unit", () => {
    const perRequest: TtsBilling = { unit: "request", rate: 0.02 };
    const cfg = config({
      promotions: [
        {
          id: "p",
          label: "Flat rate week",
          from: null,
          until: null,
          scope: ["speech"],
          rates: { speech: 0.01 },
        },
      ],
    });
    const charge = priceSpeechRequest(
      perRequest,
      cfg,
      u({ chars: 100, audioSeconds: 5, requests: 3 }),
      { at: utc(THU, "12:00") },
    );
    expect(charge.amount).toBeCloseTo(0.03, 12);
    expect(speechWhy(charge).join(" ")).toContain("/ request");
  });
});

describe("an invalid rate card blocks a speech endpoint too", () => {
  test("malformed pricing is an error on a speech endpoint, not only on a scripting profile", () => {
    const ep = ttsEndpointForPricing();
    expect(endpointErrors(unifyEndpoint(ep))).toEqual([]);
    ep.pricing!.promotions = [
      { id: "dup", label: "A", from: null, until: null, scope: ["speech"], percent: 10 },
      { id: "dup", label: "B", from: null, until: null, scope: ["speech"], percent: 20 },
    ];
    expect(endpointErrors(unifyEndpoint(ep)).join(" ")).toContain("share the id");

    ep.pricing!.promotions = [
      { id: "b", label: "Backwards", from: 2000, until: 1000, scope: ["speech"], percent: 10 },
    ];
    expect(endpointErrors(unifyEndpoint(ep)).join(" ")).toContain("ends before it starts");

    ep.pricing!.promotions = [];
    ep.pricing!.windows = [{ id: "w", label: "Bad", days: [], from: -1, to: 99999, percent: 10 }];
    expect(endpointErrors(unifyEndpoint(ep)).join(" ")).toContain("outside 00:00–23:59");
  });
});

describe("billing models: what is counted, and what that costs", () => {
  test("the three counts of one line are different numbers and never conversions of each other", () => {
    // 11 characters; the two Hanzi are three UTF-8 bytes each, the nine ASCII ones are one
    const text = "外门 disciple";
    expect(billableChars(text)).toBe(11);
    expect(utf8Bytes(text)).toBe(6 + 9);
    // an emoji is one billable character and four bytes — `String.length` says two and is wrong twice
    expect(billableChars("🜁")).toBe(1);
    expect("🜁".length).toBe(2);
    expect(utf8Bytes("🜁")).toBe(4);
  });

  test("counting is of what was submitted, not of the source text or the split limit", () => {
    const billing: TtsBilling = { unit: "bytes", rate: 15 };
    // the line as the endpoint receives it: after the dictionary and the expression tags
    const submitted = measureSpeech(
      { text: "[softly] 外门 disciple", instructions: "weary, half-asleep", requests: 4 },
      billing,
    );
    expect(submitted.chars).toBe(billableChars("[softly] 外门 disciple\nweary, half-asleep"));
    expect(submitted.bytes).toBeGreaterThan(submitted.chars);
    // the instructions are part of it, and separately visible
    expect(submitted.instructionChars).toBe("weary, half-asleep".length);
    // and the split limit changes the request count without changing what was counted
    expect(submitted.requests).toBe(4);
    const unsplit = measureSpeech(
      { text: "[softly] 外门 disciple", instructions: "weary, half-asleep", requests: 1 },
      billing,
    );
    expect(unsplit.chars).toBe(submitted.chars);
    expect(unsplit.bytes).toBe(submitted.bytes);
  });

  test("an endpoint that does not bill for instructions does not count them", () => {
    const sent = { text: "Hello there.", instructions: "briskly" };
    expect(measureSpeech(sent, { unit: "chars", rate: 1 }).chars).toBe(
      "Hello there.\nbriskly".length,
    );
    expect(measureSpeech(sent, { unit: "chars", rate: 1, billsInstructions: false }).chars).toBe(
      "Hello there.".length,
    );
    // and they are still sent — only the billable count changes
    expect(
      measureSpeech(sent, { unit: "chars", rate: 1, billsInstructions: false }).instructionChars,
    ).toBe(0);
  });

  test("a byte-billed endpoint charges the bytes, and a character-billed one the characters", () => {
    const cfg = config();
    const at = utc(THU, "12:00");
    const sent = { text: "外门".repeat(1000), requests: 1, audioSeconds: 0 };
    const bytes: TtsBilling = { unit: "bytes", rate: 15 };
    const chars: TtsBilling = { unit: "chars", rate: 15 };

    const byBytes = priceSpeechRequest(bytes, cfg, measureSpeech(sent, bytes), { at });
    const byChars = priceSpeechRequest(chars, cfg, measureSpeech(sent, chars), { at });
    // 2,000 characters, 6,000 bytes: the same rate over the same text, three times the bill
    expect(byChars.lines[0].quantity).toBe(2000);
    expect(byBytes.lines[0].quantity).toBe(6000);
    expect(byBytes.amount!).toBeCloseTo(byChars.amount! * 3, 12);
    // and each receipt still records both counts, so the comparison is inspectable
    expect(byChars.units.bytes).toBe(6000);
    expect(byBytes.units.chars).toBe(2000);
  });

  test("a token-billed endpoint charges the text and the audio separately and adds them", () => {
    const billing: TtsBilling = {
      unit: "audio-tokens",
      rate: 1,
      audioRate: 20,
      audioTokensPerSecond: 25,
    };
    const units = measureSpeech(
      { text: "a".repeat(4000), requests: 1, audioSeconds: 120 },
      billing,
    );
    expect(units.textTokens).toBe(1000);
    expect(units.audioTokens).toBe(3000);
    const charge = priceSpeechRequest(billing, config(), units, { at: utc(THU, "12:00") });
    expect(charge.lines.map((l) => l.component)).toEqual(["textTokens", "audioTokens"]);
    const input = (1000 / 1e6) * 1;
    const audio = (3000 / 1e6) * 20;
    expect(charge.lines[0].amount!).toBeCloseTo(input, 12);
    expect(charge.lines[1].amount!).toBeCloseTo(audio, 12);
    expect(charge.amount!).toBeCloseTo(input + audio, 12);
    // the audio side is not a text-token approximation: it follows the duration
    expect(charge.lines[1].quantity).toBe(Math.round(120 * 25));
  });

  test("audio tokens follow the configured conversion, and it is recorded on the receipt", () => {
    const at = utc(THU, "12:00");
    const price = (perSecond: number) => {
      const billing: TtsBilling = {
        unit: "audio-tokens",
        rate: 1,
        audioRate: 20,
        audioTokensPerSecond: perSecond,
      };
      return priceSpeechRequest(
        billing,
        config(),
        measureSpeech({ text: "hello", audioSeconds: 60 }, billing),
        { at },
      );
    };
    const slow = price(25);
    const fast = price(50);
    expect(fast.lines[1].quantity).toBe(slow.lines[1].quantity * 2);
    expect(slow.audioTokensPerSecond).toBe(25);
    expect(fast.audioTokensPerSecond).toBe(50);
    // and it is an assumption, so the charge says so rather than presenting it as measured
    expect(slow.basis).toBe("estimated");
    expect(slow.unknowns.join(" ")).toContain("tokens-per-second");
  });

  test("half a token rate prices nothing at all rather than half a request", () => {
    const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: null };
    const charge = priceSpeechRequest(
      billing,
      config(),
      measureSpeech({ text: "hello", audioSeconds: 10 }, billing),
      { at: utc(THU, "12:00") },
    );
    expect(charge.amount).toBeNull();
    expect(charge.basis).toBe("unknown");
    expect(charge.unknowns.join(" ")).toContain("only one of the two rates");
    expect(billingProblems(billing)).toEqual([]);
  });

  test("zero is free and blank is unknown, and they never read as the same thing", () => {
    const at = utc(THU, "12:00");
    const units = measureSpeech({ text: "hello", audioSeconds: 2 }, { unit: "chars", rate: 0 });
    const free = priceSpeechRequest({ unit: "chars", rate: 0 }, config(), units, { at });
    const unknown = priceSpeechRequest({ unit: "chars", rate: null }, config(), units, { at });
    expect(free.amount).toBe(0);
    expect(free.basis).toBe("calculated");
    expect(free.unknowns).toEqual([]);
    expect(unknown.amount).toBeNull();
    expect(unknown.basis).toBe("unknown");
  });
});

describe("what the provider said", () => {
  test("a speech provider that reports nothing leaves every count unknown, not zero", () => {
    const u = normalizeSpeechUsage(null, "none");
    expect(u.chars).toBeNull();
    expect(u.bytes).toBeNull();
    expect(u.textTokens).toBeNull();
    expect(u.audioTokens).toBeNull();
    expect(u.problems.map((p) => p.code)).toContain("usage-not-reported");
  });

  test("Gemini's audio tokens are the AUDIO slice of the response, not the whole of it", () => {
    const u = normalizeSpeechUsage(
      {
        usageMetadata: {
          promptTokenCount: 412,
          candidatesTokenCount: 5000,
          candidatesTokensDetails: [
            { modality: "TEXT", tokenCount: 120 },
            { modality: "AUDIO", tokenCount: 4880 },
          ],
        },
      },
      "gemini",
    );
    expect(u.textTokens).toBe(412);
    expect(u.audioTokens).toBe(4880);
  });

  test("Fish reports the bytes it bills on, and that is what is charged", () => {
    const billing: TtsBilling = { unit: "bytes", rate: 15 };
    const reported = normalizeSpeechUsage({ usage: { bytes: 9000, characters: 3000 } }, "fish");
    expect(reported.bytes).toBe(9000);
    const charge = priceSpeechRequest(
      billing,
      config(),
      // we counted a slightly different number on the way out; the provider's is the one billed
      measureSpeech({ text: "外门".repeat(1400) }, billing),
      { at: utc(THU, "12:00"), reported },
    );
    expect(charge.lines[0].quantity).toBe(9000);
    expect(charge.lines[0].source).toBe("reported");
    expect(charge.amount!).toBeCloseTo((9000 / 1e6) * 15, 12);
    // a figure worked out from reported usage is "calculated", not "estimated"
    expect(charge.basis).toBe("calculated");
  });

  test("a reported charge and one calculated from reported usage are kept apart", () => {
    const billing: TtsBilling = { unit: "bytes", rate: 15 };
    const reported = {
      ...normalizeSpeechUsage({ usage: { bytes: 9000 } }, "fish"),
      reportedCost: 0.2,
    };
    const units = measureSpeech({ text: "hello" }, billing);
    const ours = priceSpeechRequest(billing, config(), units, { at: utc(THU, "12:00"), reported });
    const theirs = priceSpeechRequest(billing, config(), units, {
      at: utc(THU, "12:00"),
      reported,
      preferReported: true,
    });
    expect(ours.basis).toBe("calculated");
    expect(theirs.basis).toBe("provider-reported");
    expect(theirs.amount).toBe(0.2);
    // both receipts keep the provider's own number beside ours rather than instead of it
    expect(ours.reported!.reportedCost).toBe(0.2);
  });

  test("a provider that reports a quantity this endpoint does not bill on is an estimate", () => {
    // it reports characters; this endpoint bills bytes, so the bytes are still ours
    const billing: TtsBilling = { unit: "bytes", rate: 15 };
    const reported = normalizeSpeechUsage({ characters: 300, audio_seconds: 12 }, "plain");
    const charge = priceSpeechRequest(
      billing,
      config(),
      measureSpeech({ text: "外门".repeat(150) }, billing),
      { at: utc(THU, "12:00"), reported },
    );
    expect(charge.lines[0].source).toBe("measured");
    expect(charge.unknowns.join(" ")).toContain("not the quantity this endpoint bills on");
  });
});

describe("changing the model", () => {
  test("the components a card prices follow its billing model and nothing else", () => {
    expect(speechComponents("chars")).toEqual(["speech"]);
    expect(speechComponents("bytes")).toEqual(["speech"]);
    expect(speechComponents("request")).toEqual(["speech"]);
    expect(speechComponents("tokens")).toEqual(["textTokens"]);
    expect(speechComponents("audio-tokens")).toEqual(["textTokens", "audioTokens"]);
    // a component the model does not price is null, never zero, so nothing can charge for it
    const card = speechRates({ unit: "chars", rate: 12 });
    expect(card.textTokens).toBeNull();
    expect(card.audioTokens).toBeNull();
    const tokens = speechRates({ unit: "audio-tokens", rate: 1, audioRate: 20 });
    expect(tokens.speech).toBeNull();
    expect(tokens.textTokens).toBe(1);
    expect(tokens.audioTokens).toBe(20);
  });

  test("a promotion scoped to the speech rate reaches a token-billed endpoint's rates too", () => {
    const cfg = config({
      promotions: [promo({ scope: ["speech"], percent: 50 })],
    });
    const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: 20 };
    const snapshot = effectiveRates(speechRates(billing), cfg, utc(THU, "12:00"), billing.unit);
    expect(snapshot.components.textTokens.rate).toBeCloseTo(0.5, 12);
    expect(snapshot.components.audioTokens.rate).toBeCloseTo(10, 12);
  });

  test("a promotion can discount the audio half and leave the text rate alone", () => {
    const cfg = config({ promotions: [promo({ scope: ["audioTokens"], percent: 50 })] });
    const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: 20 };
    const snapshot = effectiveRates(speechRates(billing), cfg, utc(THU, "12:00"), billing.unit);
    expect(snapshot.components.textTokens.rate).toBe(1);
    expect(snapshot.components.audioTokens.rate).toBeCloseTo(10, 12);
  });

  test("a rate quoted in a reason wears the unit its component is billed in", () => {
    const cfg = config({
      promotions: [promo({ scope: ["audioTokens"], rates: { audioTokens: 9 } })],
    });
    const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: 20 };
    const snapshot = effectiveRates(speechRates(billing), cfg, utc(THU, "12:00"), billing.unit);
    expect(snapshot.components.audioTokens.why.join(" ")).toContain("/ 1M audio tokens");
    expect(snapshot.components.audioTokens.why.join(" ")).not.toContain("/ 1M chars");
  });

  test("a receipt keeps the billing model it was charged under", () => {
    const billing: TtsBilling = { unit: "bytes", rate: 15 };
    const units = measureSpeech({ text: "外门".repeat(100) }, billing);
    const charge = priceSpeechRequest(billing, config(), units, { at: utc(THU, "12:00") });
    expect(charge.unit).toBe("bytes");
    const before = charge.amount;
    // the endpoint moves to token billing afterwards; the receipt does not move with it
    billing.unit = "audio-tokens";
    billing.rate = 1;
    billing.audioRate = 20;
    expect(charge.unit).toBe("bytes");
    expect(charge.amount).toBe(before);
    expect(charge.lines[0].rate).toBe(15);
  });

  test("a billing model is validated for contradictions but not for being incomplete", () => {
    expect(billingProblems({ unit: "chars", rate: null })).toEqual([]);
    expect(billingProblems({ unit: "chars", rate: -1 })).toHaveLength(1);
    expect(billingProblems({ unit: "audio-tokens", rate: 1, audioRate: -2 })).toHaveLength(1);
    expect(
      billingProblems({ unit: "audio-tokens", rate: 1, audioRate: 20, audioTokensPerSecond: 0 }),
    ).toHaveLength(1);
  });

  test("an estimate splits the input side from the audio side and they add to the total", () => {
    const billing: TtsBilling = {
      unit: "audio-tokens",
      rate: 1,
      audioRate: 20,
      audioTokensPerSecond: 25,
    };
    const units = measureSpeech(
      { text: "a".repeat(40_000), requests: 1, audioSeconds: 1200 },
      billing,
    );
    const e = estimateSpeech(billing, config(), units, utc(THU, "12:00"));
    expect(e.inputCost!).toBeCloseTo((10_000 / 1e6) * 1, 12);
    expect(e.audioCost!).toBeCloseTo((30_000 / 1e6) * 20, 12);
    expect(e.cost!).toBeCloseTo(e.inputCost! + e.audioCost!, 12);
    // and the assumption behind the audio half is named rather than left implicit
    expect(e.cautions.join(" ")).toContain("25 audio tokens a second");
  });

  test("a character-billed estimate has no audio side at all", () => {
    const billing: TtsBilling = { unit: "chars", rate: 12 };
    const e = estimateSpeech(
      billing,
      config(),
      measureSpeech({ text: "a".repeat(1_000_000), audioSeconds: 600 }, billing),
      utc(THU, "12:00"),
    );
    expect(e.audioCost).toBeNull();
    expect(e.inputCost!).toBeCloseTo(12, 12);
    expect(e.cost!).toBeCloseTo(12, 12);
  });

  test("switching billing model never reinterprets a rate, and parks it instead", () => {
    const chars: TtsBilling = { unit: "chars", rate: 15 };
    const toBytes = switchBillingUnit(chars, "bytes");
    // $15 per million characters is not $15 per million bytes, so the new model starts unknown
    expect(toBytes.unit).toBe("bytes");
    expect(toBytes.rate).toBeNull();
    expect(toBytes.parked!.chars).toEqual({ rate: 15 });

    // fill the byte rate in, move to token billing, and both earlier models are still on record
    const bytes: TtsBilling = { ...toBytes, rate: 15 };
    const toTokens = switchBillingUnit(bytes, "audio-tokens");
    expect(toTokens.rate).toBeNull();
    expect(toTokens.audioRate).toBeNull();
    expect(toTokens.audioTokensPerSecond).toBe(25);
    expect(toTokens.parked!.chars!.rate).toBe(15);
    expect(toTokens.parked!.bytes!.rate).toBe(15);

    // and going back restores what was configured rather than asking for it again
    const back = switchBillingUnit({ ...toTokens, rate: 1, audioRate: 20 }, "chars");
    expect(back.rate).toBe(15);
    expect(back.parked!.chars).toBeUndefined();
    expect(back.parked!["audio-tokens"]).toEqual({ rate: 1, audioRate: 20 });
  });

  test("switching to the same model changes nothing at all", () => {
    const chars: TtsBilling = { unit: "chars", rate: 15 };
    expect(switchBillingUnit(chars, "chars")).toBe(chars);
  });

  test("the seeded speech endpoints cover every billing model", () => {
    const byId = (id: string) => makeEndpoints(Date.now()).find((e) => e.id === id)!;
    expect(billingOf(byId("openai")).unit).toBe("chars");
    // Fish bills the bytes, whatever its price page calls them
    expect(billingOf(byId("fish"))).toMatchObject({ unit: "bytes", rate: 15 });
    // two rates, and the audio conversion is explicit rather than implied
    expect(billingOf(byId("gemini"))).toMatchObject({
      unit: "audio-tokens",
      rate: 1,
      audioRate: 20,
      audioTokensPerSecond: 25,
    });
    // free is zero and unconfigured is null, and the seeded world has one of each
    expect(billingOf(byId("local")).rate).toBe(0);
    expect(billingOf(byId("proxy")).rate).toBeNull();
    // the Gemini promotion touches the audio half only
    const preview = byId("gemini").pricing!.promotions[0];
    expect(preview.scope).toEqual(["audioTokens"]);
    expect(promotionRunning(preview, Date.now())).toBe(true);
  });

  test("a preset that bills in bytes says so, and the rate is the published one", () => {
    const fish = TTS_PRESETS.find((p) => p.id === "fish-pro")!;
    expect(fish.apply.billing).toEqual({ unit: "bytes", rate: 15 });
    expect(fish.note).toContain("UTF-8 bytes");
    const gemini = TTS_PRESETS.find((p) => p.id === "gemini-tts")!;
    expect(gemini.apply.billing).toMatchObject({ unit: "audio-tokens", rate: 1, audioRate: 20 });
  });

  test("a promotion is only called useless where the card prices something for it to miss", () => {
    const cfg = config({ promotions: [promo({ scope: ["speech"], percent: 20 })] });
    // an endpoint whose rate nobody typed in: the scope is not the problem, and saying so would send
    // the reader after the wrong thing
    expect(
      pricingWarnings(speechRates({ unit: "audio-tokens", rate: null }), cfg, utc(THU, "12:00")),
    ).toEqual([]);
    // a speech-scoped promotion does reach a token-billed card, so it is not useless there either
    expect(
      pricingWarnings(
        speechRates({ unit: "audio-tokens", rate: 1, audioRate: 20 }),
        cfg,
        utc(THU, "12:00"),
      ),
    ).toEqual([]);
    // but one scoped to the output tokens of a chat model really does apply to nothing on this card
    const wrong = config({ promotions: [promo({ scope: ["output"], percent: 20 })] });
    expect(
      pricingWarnings(
        speechRates({ unit: "audio-tokens", rate: 1, audioRate: 20 }),
        wrong,
        utc(THU, "12:00"),
      ).join(" "),
    ).toContain("applies to nothing");
  });
});
