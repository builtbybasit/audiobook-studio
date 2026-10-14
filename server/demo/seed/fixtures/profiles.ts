// The demo's scripting profiles; `newProfile` fills the defaults. Rate cards cover cached input
// with off-peak, cache writes with promotions (running, expired, upcoming), and plain pricing.
// Dates are relative to when the world is built.
import { newProfile } from "@/lib/scripting";
import type { Profile, Promotion, RateWindow } from "@/types";

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

/** Nights and weekends; crosses midnight on purpose, the case a schedule usually gets wrong. */
const OFF_PEAK: RateWindow = {
  id: "off-peak",
  label: "Off-peak",
  days: [0, 1, 2, 3, 4, 5, 6],
  from: hm(22),
  to: hm(6),
  percent: 40,
};

/** Weekday business hours: a surcharge written as explicit rates. */
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
      // ended last week; kept as history
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
        // OpenAI doesn't bill cache writes: `null` means "no separate line", not "free"
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
        // this provider's `input_tokens` excludes cache reads and writes; the normalizer adds them
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
      // self-hosted: no rates, schedule or promotions
    }),
  ];
}
