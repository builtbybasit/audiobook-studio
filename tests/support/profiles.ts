// A scripting profile for tests to price, save and run against.
//
// The demo's profiles are its own: their rates, schedules and promotions are there to show every
// pricing case on screen, and they change when the demo does. A test that only needs a priced chat
// model takes this one instead, so editing the demo never moves a figure a test asserts. It keeps
// the name, model and credential the demo's OpenAI profile has, which the tests that save it and
// read it back refer to, and it has no schedule or promotion, so what it charges does not depend
// on when the test runs.
import { newProfile } from "@/lib/scripting";
import type { Profile } from "@/types";

/**
 * OpenAI's gpt-4o-mini at $0.15 in / $0.60 out per million tokens, cached input at a quarter of
 * that, on the `openai-personal` credential the page's registry holds. `over` is what a test is
 * about — a request size, a price, a prompt — so it reads at the call site.
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
