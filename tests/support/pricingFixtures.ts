import { newPricing, noUnits } from "@/lib/pricing";
import type { BillableUnits, PricingConfig, Promotion, RateSet } from "@/types";

export const card = (over: Partial<RateSet> = {}): RateSet => ({
  input: 1,
  output: 4,
  cachedInput: null,
  cacheWrite: null,
  speech: null,
  ...over,
});

export const config = (over: Partial<PricingConfig> = {}): PricingConfig =>
  newPricing({ timezone: "UTC", ...over });

export const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: "p",
  label: "P",
  from: null,
  until: null,
  scope: ["model"],
  percent: 50,
  ...over,
});

/** Measured units for a speech request, with everything nobody set left at zero. */
export const u = (over: Partial<BillableUnits> = {}): BillableUnits => ({
  ...noUnits(),
  requests: 1,
  ...over,
});

/** An instant with a known UTC wall clock, so window tests read as wall-clock tests. */
export const utc = (day: string, time: string): number => Date.parse(`${day}T${time}:00.000Z`);
// 2026-09-17 is a Thursday
export const THU = "2026-09-17";
export const FRI = "2026-09-18";
export const SAT = "2026-09-19";
