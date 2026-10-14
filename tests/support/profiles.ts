// A priced scripting profile for tests, independent of the demo's (whose rates change with it). It
// keeps the demo OpenAI profile's name, model and credential, and has no schedule or promotion, so
// its charges don't depend on when the test runs.
import { newProfile } from "@/lib/scripting";
import type { Profile } from "@/types";

/**
 * gpt-4o-mini at $0.15 in / $0.60 out per 1M tokens, cached input a quarter of that, on the
 * `openai-personal` credential. `over` is what the test is about, so it reads at the call site.
 */
export const openaiProfile = (over: Partial<Profile> = {}): Profile => ({
  ...newProfile({
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
      cachedInput: 0.075,
      cacheWrite: null,
      timezone: "UTC",
      windows: [],
      promotions: [],
    },
  }),
  ...over,
});
