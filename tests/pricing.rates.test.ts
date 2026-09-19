import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import {
  activeWindow,
  baseRates,
  effectiveRates,
  ensurePricing,
  nextChange,
  pricingProblems,
  pricingWarnings,
  promotionExpired,
  promotionRunning,
  windowCovers,
} from "@/lib/pricing";
import { calendarDay, endOfDay, endOfDayAfter, localClock, startOfDay } from "@/lib/wallClock";
import { newProfile, tokenEstimate } from "@/lib/scripting";
import type { RateWindow } from "@/types";
import { FRI, SAT, THU, card, config, promo, utc } from "./support/pricingFixtures";

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
});

describe("schedule boundaries", () => {
  test("a window that runs past midnight covers both sides of it", () => {
    const night: RateWindow = {
      id: "n",
      label: "Off-peak",
      days: [],
      from: 22 * 60,
      to: 6 * 60,
      percent: 50,
    };
    const cfg = config({ windows: [night] });
    expect(activeWindow(cfg, utc(THU, "23:30")).window).toBe(night);
    expect(activeWindow(cfg, utc(FRI, "05:59")).window).toBe(night);
    // the edges: inclusive at the start, exclusive at the end
    expect(activeWindow(cfg, utc(THU, "22:00")).window).toBe(night);
    expect(activeWindow(cfg, utc(FRI, "06:00")).window).toBeNull();
    expect(activeWindow(cfg, utc(THU, "21:59")).window).toBeNull();
    expect(activeWindow(cfg, utc(THU, "12:00")).window).toBeNull();
  });

  test("the day list of a midnight-crossing window names the day it starts on", () => {
    // Friday 22:00 – Saturday 02:00
    const w: RateWindow = { id: "w", label: "Fri night", days: [5], from: 22 * 60, to: 2 * 60 };
    const day = (t: number) => localClock(t, "UTC");
    expect(windowCovers(w, day(utc(FRI, "23:00")).day, day(utc(FRI, "23:00")).minutes)).toBe(true);
    // Saturday 01:00 is the tail of the Friday window
    expect(windowCovers(w, day(utc(SAT, "01:00")).day, day(utc(SAT, "01:00")).minutes)).toBe(true);
    // Saturday 23:00 is not: the window does not start on Saturday
    expect(windowCovers(w, day(utc(SAT, "23:00")).day, day(utc(SAT, "23:00")).minutes)).toBe(false);
    // and Friday 01:00 belongs to Thursday's window, which does not exist
    expect(windowCovers(w, day(utc(FRI, "01:00")).day, day(utc(FRI, "01:00")).minutes)).toBe(false);
  });

  test("windows do not stack: the first one in the list that covers the moment wins", () => {
    const a: RateWindow = { id: "a", label: "A", days: [], from: 0, to: 1439, percent: 20 };
    const b: RateWindow = { id: "b", label: "B", days: [], from: 0, to: 1439, percent: 90 };
    const at = utc(THU, "12:00");
    expect(
      effectiveRates(card(), config({ windows: [a, b] }), at).components.input.rate,
    ).toBeCloseTo(0.8, 12);
    // reordering is how precedence is changed, and it is the only thing that changes it
    expect(
      effectiveRates(card(), config({ windows: [b, a] }), at).components.input.rate,
    ).toBeCloseTo(0.1, 12);
  });

  test("a window is read in its own timezone, not the machine's", () => {
    const w: RateWindow = { id: "w", label: "Night", days: [], from: 0, to: 6 * 60, percent: 50 };
    // 2026-09-17 03:00 UTC is 11:00 in Shanghai and 23:00 the previous day in New York
    const at = utc(THU, "03:00");
    expect(activeWindow(config({ windows: [w] }), at).window).toBe(w);
    expect(activeWindow(config({ timezone: "Asia/Shanghai", windows: [w] }), at).window).toBeNull();
    expect(
      activeWindow(config({ timezone: "America/New_York", windows: [w] }), at).window,
    ).toBeNull();
  });

  test("an unreadable timezone falls back to UTC and says it did rather than pretending", () => {
    const cfg = config({ timezone: "Mars/Olympus" });
    const snapshot = effectiveRates(card(), cfg, utc(THU, "12:00"));
    expect(snapshot.timezoneOk).toBe(false);
    expect(pricingProblems(cfg).join(" ")).toContain("not a timezone");
  });

  test("the next change is the next boundary that actually moves a rate", () => {
    const cfg = config({
      windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 50 }],
    });
    const change = nextChange(card(), cfg, utc(THU, "20:00"));
    expect(change?.label).toBe("Off-peak starts");
    expect(change?.at).toBe(utc(THU, "22:00"));

    const inside = nextChange(card(), cfg, utc(THU, "23:00"));
    expect(inside?.label).toBe("Off-peak ends");
    expect(inside?.at).toBe(utc(FRI, "06:00"));

    // a card with nothing scheduled has no next change at all
    expect(nextChange(card(), config(), utc(THU, "20:00"))).toBeNull();
  });
});

describe("promotions", () => {
  test("a promotion applies on top of the schedule, not instead of it", () => {
    const cfg = config({
      windows: [{ id: "n", label: "Off-peak", days: [], from: 0, to: 1439, percent: 50 }],
      promotions: [promo({ percent: 50 })],
    });
    const r = effectiveRates(card(), cfg, utc(THU, "12:00")).components.input;
    expect(r.base).toBe(1);
    expect(r.scheduled).toBeCloseTo(0.5, 12);
    // 50% off the scheduled rate, not 100% off the base rate
    expect(r.rate).toBeCloseTo(0.25, 12);
    expect(r.why).toHaveLength(2);
  });

  test("promotions do not stack: only the cheapest applies to a component", () => {
    const cfg = config({
      promotions: [
        promo({ id: "a", label: "A", percent: 30 }),
        promo({ id: "b", label: "B", percent: 60 }),
      ],
    });
    const snapshot = effectiveRates(card(), cfg, utc(THU, "12:00"));
    expect(snapshot.components.input.rate).toBeCloseTo(0.4, 12);
    expect(snapshot.applied.map((p) => p.id)).toEqual(["b"]);
    // the one that lost is named rather than silently dropped
    expect(snapshot.shadowed.map((p) => p.id)).toEqual(["a"]);
    // and it is never 30% and then 60% of what is left
    expect(snapshot.components.input.rate).not.toBeCloseTo(0.28, 6);
  });

  test("a tie between two promotions goes to the one ending soonest", () => {
    const now = utc(THU, "12:00");
    const cfg = config({
      promotions: [
        promo({ id: "long", label: "Long", percent: 50, until: now + 30 * 86400e3 }),
        promo({ id: "short", label: "Short", percent: 50, until: now + 2 * 86400e3 }),
      ],
    });
    expect(effectiveRates(card(), cfg, now).applied.map((p) => p.id)).toEqual(["short"]);
  });

  test("a promotion's scope decides which rates it touches", () => {
    const cfg = config({
      promotions: [promo({ scope: ["output"], percent: 50 })],
    });
    const c = effectiveRates(card({ cachedInput: 0.25 }), cfg, utc(THU, "12:00")).components;
    expect(c.output.rate).toBeCloseTo(2, 12);
    expect(c.input.rate).toBe(1);
    expect(c.cachedInput.rate).toBe(0.25);

    // "model" covers every component the endpoint prices, and only those
    const all = effectiveRates(
      card({ cachedInput: 0.25 }),
      config({ promotions: [promo({ scope: ["model"], percent: 50 })] }),
      utc(THU, "12:00"),
    ).components;
    expect(all.input.rate).toBeCloseTo(0.5, 12);
    expect(all.cachedInput.rate).toBeCloseTo(0.125, 12);
    // a component the endpoint does not price stays unpriced; a promotion cannot invent a rate
    expect(all.cacheWrite.rate).toBeNull();
  });

  test("a promotion can replace rates outright, ignoring the schedule for what it names", () => {
    const cfg = config({
      windows: [
        { id: "p", label: "Peak", days: [], from: 0, to: 1439, rates: { input: 2, output: 8 } },
      ],
      promotions: [promo({ scope: ["input"], percent: undefined, rates: { input: 0.1 } })],
    });
    const c = effectiveRates(card(), cfg, utc(THU, "12:00")).components;
    expect(c.input.scheduled).toBe(2);
    expect(c.input.rate).toBe(0.1);
    expect(c.output.rate).toBe(8);
  });

  test("an expired promotion stops applying and stays on the record", () => {
    const now = utc(THU, "12:00");
    const ended = promo({ id: "old", label: "Old", until: now - 86400e3 });
    const later = promo({ id: "new", label: "Later", from: now + 86400e3 });
    const cfg = config({ promotions: [ended, later] });
    const snapshot = effectiveRates(card(), cfg, now);
    expect(snapshot.applied).toEqual([]);
    expect(snapshot.components.input.rate).toBe(1);
    // nothing was deleted
    expect(cfg.promotions).toHaveLength(2);
    expect(promotionExpired(ended, now)).toBe(true);
    expect(promotionRunning(later, now)).toBe(false);
    // and at an instant while it ran, it applied
    expect(effectiveRates(card(), cfg, now - 2 * 86400e3).applied.map((p) => p.id)).toEqual([
      "old",
    ]);
  });

  test("a promotion expiry is a next change, and the rate is back the moment it passes", () => {
    const now = utc(THU, "12:00");
    const until = now + 3600e3;
    const cfg = config({ promotions: [promo({ until })] });
    expect(nextChange(card(), cfg, now)).toEqual({ at: until, label: "P ends" });
    expect(effectiveRates(card(), cfg, until - 1).components.input.rate).toBeCloseTo(0.5, 12);
    expect(effectiveRates(card(), cfg, until).components.input.rate).toBe(1);
  });

  test("two promotions on one component are called out as not stacking", () => {
    const cfg = config({
      promotions: [
        promo({ id: "a", label: "A", percent: 30 }),
        promo({ id: "b", label: "B", percent: 60 }),
      ],
    });
    expect(pricingWarnings(card(), cfg, utc(THU, "12:00")).join(" ")).toContain("do not stack");
  });
});

describe("configuration validation", () => {
  test("contradictory rate cards are reported rather than silently priced", () => {
    const problems = pricingProblems(
      config({
        windows: [{ id: "w", label: "", days: [], from: 0, to: 60 }],
        promotions: [
          promo({ id: "a", label: "A", from: 100, until: 50 }),
          promo({ id: "b", label: "B", scope: [], percent: 0 }),
        ],
      }),
    );
    const text = problems.join(" | ");
    expect(text).toContain("needs a name");
    expect(text).toContain("does not change any rate");
    expect(text).toContain("ends before it starts");
    expect(text).toContain("pick a scope");
  });

  test("a cached rate dearer than ordinary input is a warning, not a blocker", () => {
    const cfg = config({ cachedInput: 5 });
    expect(pricingProblems(cfg)).toEqual([]);
    expect(pricingWarnings(card(), cfg, utc(THU, "12:00")).join(" ")).toContain("right way round");
  });

  test("a profile with no advanced pricing prices exactly as it always did", () => {
    const p = newProfile({ id: "p", name: "P", model: "m", inPrice: 0.15, outPrice: 0.6 });
    const cfg = ensurePricing(p);
    expect(cfg.windows).toEqual([]);
    expect(cfg.promotions).toEqual([]);
    expect(cfg.cachedInput).toBeNull();
    const at = Date.now();
    const e = tokenEstimate("x".repeat(4000), p, at);
    const tokens = { inputTokens: e.inputTokens, outputTokens: e.outputTokens };
    expect(e.cost).toBeCloseTo((tokens.inputTokens * 0.15 + tokens.outputTokens * 0.6) / 1e6, 12);
    expect(effectiveRates(baseRates(p), cfg, at).next).toBeNull();
  });
});

describe("calendar dates belong to the endpoint, not to the operator", () => {
  test("a calendar date is read and written in the endpoint's own timezone", () => {
    const ny = "America/New_York";
    // 02:00 UTC is still the previous evening in New York
    expect(calendarDay(Date.UTC(2026, 8, 17, 2, 0, 0), ny)).toBe("2026-09-16");
    expect(calendarDay(Date.UTC(2026, 8, 17, 2, 0, 0), "Asia/Karachi")).toBe("2026-09-17");
    // a promotion starting on the 17th starts at midnight *there* — 04:00 UTC in September
    expect(new Date(startOfDay("2026-09-17", ny)!).toISOString()).toBe("2026-09-17T04:00:00.000Z");
    // and one ending on the 17th runs to the last moment of that day there
    expect(new Date(endOfDay("2026-09-17", ny)!).toISOString()).toBe("2026-09-18T03:59:59.999Z");
    // winter is an hour further out, so the offset is read at the date rather than assumed
    expect(new Date(endOfDay("2026-01-17", ny)!).toISOString()).toBe("2026-01-18T04:59:59.999Z");
    // a zone the browser cannot read falls back to UTC rather than to the operator's own
    expect(calendarDay(Date.UTC(2026, 8, 17, 2, 0, 0), "Not/AZone")).toBe("2026-09-17");
  });

  test("a promotion edited from another timezone keeps the day it names", () => {
    const ny = "America/New_York";
    // the day a promotion ends, read back out, is the day that was typed — whatever zone reads it
    for (const day of ["2026-03-07", "2026-03-08", "2026-11-01", "2026-06-30"]) {
      expect(calendarDay(endOfDay(day, ny)!, ny)).toBe(day);
      expect(calendarDay(startOfDay(day, ny)!, ny)).toBe(day);
    }
    // seven days on from an instant is seven calendar days on where the endpoint is billed
    expect(calendarDay(endOfDayAfter(Date.UTC(2026, 8, 17, 12), ny, 7), ny)).toBe("2026-09-24");
  });
});
