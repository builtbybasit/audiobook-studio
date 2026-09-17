// The scripting endpoints (LLM side) the prototype starts with. `newProfile` fills in every
// operational default, so these entries only say what actually differs between the three.
//
// Their rate cards are the demo: between them they cover an endpoint with cached-input pricing and
// an off-peak schedule, one that also charges for cache writes and is mid-promotion with an expired
// one behind it, and one with no advanced pricing at all — which is what "ordinary pricing stays
// simple" has to look like for the page to be worth anything.
//
// Dates are relative to when the world is built, so the seeded promotions are always the same
// distance from "now": one running and ending on Friday, one that ended last week and is kept as
// history, one that has not started yet.
import { newProfile } from "@/lib/scripting";
import type { Profile, Promotion, RateWindow, ScriptSettings } from "@/types";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const hm = (h: number, m = 0): number => h * 60 + m;

/** The next occurrence of a weekday at local midnight, as an absolute instant. */
function nextWeekday(from: number, day: number): number {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((((day - d.getDay()) % 7) + 7) % 7) || 7);
  return d.getTime();
}

/**
 * The nights and weekends discount a lot of providers offer. It runs past midnight on purpose —
 * that is the case a schedule usually gets wrong, so the seeded world always has one on screen.
 */
const OFF_PEAK: RateWindow = {
  id: "off-peak",
  label: "Off-peak",
  days: [0, 1, 2, 3, 4, 5, 6],
  from: hm(22),
  to: hm(6),
  percent: 40,
};

/** Weekday business hours, dearer than the card rate — a surcharge written as explicit rates. */
const PEAK = (inPrice: number, outPrice: number): RateWindow => ({
  id: "peak",
  label: "Peak hours",
  days: [1, 2, 3, 4, 5],
  from: hm(9),
  to: hm(18),
  rates: { input: inPrice * 1.25, output: outPrice * 1.25 },
});

function promotions(now: number): Promotion[] {
  return [
    {
      id: "spring-50",
      label: "50% off gpt-4o-mini",
      from: now - 3 * DAY,
      until: nextWeekday(now, 5) + hm(23, 59) * 60e3,
      scope: ["model"],
      percent: 50,
      note: "Launch pricing. Applies to every component this model prices.",
    },
    {
      id: "cache-free",
      label: "Free cache reads",
      // ended last week: kept so the history is readable, and it no longer applies to anything
      from: now - 21 * DAY,
      until: now - 7 * DAY,
      scope: ["cachedInput"],
      rates: { cachedInput: 0 },
      note: "Ended. Requests priced while it ran keep the rates they were charged at.",
    },
    {
      id: "output-half",
      label: "Half-price output",
      from: now + 2 * DAY,
      until: now + 16 * DAY,
      scope: ["output"],
      percent: 50,
      note: "Starts in two days. Nothing is charged at this rate until then.",
    },
  ];
}

export function makeProfiles(now: number = Date.now()): Profile[] {
  return [
    newProfile({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      inPrice: 0.15,
      outPrice: 0.6,
      secPerChunk: 9,
      credentialId: "openai-personal",
      quotaGroup: "openai-account",
      spendLimit: 10,
      pricing: {
        // cached input at a quarter of the card rate; OpenAI does not bill cache writes at all,
        // which is what `null` says — not "free", but "no separate line for it"
        cachedInput: 0.075,
        cacheWrite: null,
        timezone: "Europe/London",
        windows: [OFF_PEAK, PEAK(0.15, 0.6)],
        promotions: promotions(now),
      },
    }),
    newProfile({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      inPrice: 0.14,
      outPrice: 0.28,
      secPerChunk: 14,
      credentialId: "deepseek",
      pricing: {
        cachedInput: 0.014,
        // this one does bill cache writes separately, dearer than ordinary input
        cacheWrite: 0.175,
        timezone: "Asia/Shanghai",
        windows: [
          {
            id: "night",
            label: "Night discount",
            days: [],
            from: hm(0, 30),
            to: hm(8, 30),
            percent: 50,
          },
        ],
        promotions: [],
      },
    }),
    newProfile({
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-5",
      inPrice: 3,
      outPrice: 15,
      secPerChunk: 11,
      credentialId: null,
      pricing: {
        // reads a tenth, writes a quarter dearer than ordinary input — and this provider reports
        // usage in the shape where `input_tokens` *excludes* both, which the normalizer undoes
        cachedInput: 0.3,
        cacheWrite: 3.75,
        timezone: "America/New_York",
        windows: [],
        promotions: [
          {
            id: "batch-week",
            label: "Cache-read week",
            from: now - DAY,
            until: now + 5 * DAY,
            scope: ["cachedInput", "cacheWrite"],
            percent: 50,
            note: "Halves both cache lines. It does not touch ordinary input or output.",
          },
        ],
      },
    }),
    newProfile({
      id: "antigravity",
      name: "Antigravity (local)",
      baseUrl: "http://localhost:8000/v1",
      model: "gemini-3.6-flash-low",
      needsKey: false,
      secPerChunk: 25,
      // no rates, no schedule, no promotions: a model you host yourself, and the plain case the
      // Pricing tab must still read cleanly for
    }),
  ];
}

export const makeScriptSettings = (): ScriptSettings => ({
  profile: "openai",
  stripWatermarks: true,
  // a re-script over chapters somebody has been correcting by hand keeps that work unless they
  // deliberately say otherwise
  keepEdits: true,
});
