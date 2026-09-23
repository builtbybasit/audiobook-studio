// The voice lister against the real Fish Audio, opt-in: `LIVE=1 bun test tests/live` with
// `FISHAUDIO_TOKEN` and `FISHAUDIO_VOICE_ID` in `.env`. Listing spends nothing: it reads the
// account's library, one page of the public catalogue, and the one voice the speech test uses.
import { describe, expect, test } from "bun:test";

import type { ProviderTarget } from "~/providers/target";
import { endpointVoiceLister, PUBLIC_PAGE } from "~/providers/voices";

const env = process.env;

describe.skipIf(!env.LIVE || !env.FISHAUDIO_TOKEN)("Fish Audio's voices, for real", () => {
  const target: ProviderTarget = {
    id: "fish-free",
    name: "Fish Audio (free)",
    baseUrl: "https://api.fish.audio/v1",
    model: "s2.1-pro-free",
    apiKey: env.FISHAUDIO_TOKEN ?? null,
    needsKey: true,
    timeoutSec: 30,
    maxRetries: 1,
    cooldownSec: 8,
  };
  const lister = endpointVoiceLister();
  const signal = () => AbortSignal.timeout(60_000);

  test("the library is read whole", async () => {
    const page = await lister.list(target, { source: "library" }, signal());
    // the account this was written against holds none; any count is an answer
    expect(page.voices.length).toBe(page.total);
    expect(page.hasMore).toBe(false);
  }, 60_000);

  test("a public search answers a page of English voices", async () => {
    const page = await lister.list(
      target,
      { source: "public", query: "narrator", language: "en" },
      signal(),
    );
    expect(page.page).toBe(1);
    expect(page.total).toBeGreaterThan(0);
    expect(page.voices.length).toBeGreaterThan(0);
    expect(page.voices.length).toBeLessThanOrEqual(PUBLIC_PAGE);
    for (const v of page.voices) {
      expect(v.id).toMatch(/^[0-9a-f]{32}$/);
      expect(v.label).toContain("EN");
    }
    const two = await lister.list(
      target,
      { source: "public", query: "narrator", language: "en", page: 2 },
      signal(),
    );
    expect(two.page).toBe(2);
    expect(two.voices[0]?.id).not.toBe(page.voices[0].id);
  }, 60_000);

  test.skipIf(!env.FISHAUDIO_VOICE_ID)(
    "the voice the speech test uses is found by id",
    async () => {
      const page = await lister.list(
        target,
        { source: "public", query: env.FISHAUDIO_VOICE_ID },
        signal(),
      );
      expect(page.voices.map((v) => v.id)).toEqual([env.FISHAUDIO_VOICE_ID!]);
    },
    60_000,
  );
});
