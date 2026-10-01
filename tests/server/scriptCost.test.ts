// What a scripting request is recorded as costing, from the gateway's answer to the ledger's row.
//
// OpenRouter says in every answer what the request was charged — at whichever of its providers
// served it, which need not be the rate its listing shows — so that figure is the cost, and the one
// worked out from the profile's card stays on the receipt beside it. A gateway that says nothing is
// priced from the card as before.
import { describe, expect, test } from "bun:test";

import type { Book, Profile } from "@/types";
import { chatScriptingProvider } from "~/providers/chatScripting";
import type { SentScript } from "~/providers/sent";
import { bookSpend, chapterUidOf, endpointSpend, settleScript } from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { testApi } from "../support/server";
import { openaiProfile } from "../support/profiles";

const TEXT = "The door opened. “Come in,” said Mara softly.";
const LINES = [
  { type: "narration", speaker: "Narrator", text: "The door opened." },
  { type: "dialogue", speaker: "Mara", text: "Come in," },
  { type: "narration", speaker: "Narrator", text: "said Mara softly." },
];

/** A profile at $2 in / $8 out per million tokens, with no schedule or promotion to move it. */
const profile: Profile = {
  ...openaiProfile(),
  inPrice: 2,
  outPrice: 8,
  pricing: undefined,
};

/** One request through the chat provider to a gateway answering with `usage`, as it reports it. */
async function sent(usage: Record<string, unknown>): Promise<SentScript> {
  const reports: SentScript[] = [];
  const fetch = (async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify({ lines: LINES }) }, finish_reason: "stop" }],
      usage,
    })) as unknown as typeof globalThis.fetch;
  await chatScriptingProvider({ fetch, backoffMs: () => 0 }).script({
    title: "Chapter One",
    text: TEXT,
    signal: new AbortController().signal,
    cast: ["Narrator", "Mara"],
    target: {
      id: profile.id,
      name: "OpenRouter",
      baseUrl: "https://openrouter.test/api/v1",
      model: "x-ai/grok-4.7",
      apiKey: "sk-test",
      needsKey: true,
      timeoutSec: 5,
      maxRetries: 0,
      cooldownSec: 0,
      maxOutputTokens: 4000,
    },
    sent: (r) => reports.push(r),
  });
  return reports[0];
}

async function work() {
  const api = testApi();
  const { body } = await api.import<{ book: Book }>(
    await epubFile({ chapters: [{ title: "One", paragraphs: story(2) }] }),
  );
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  return {
    api,
    work: {
      bookId: body.book.id,
      chapterUid: chapterUidOf(api.db, body.book.id, 1),
      label: "Script chunk 1 · ch 1",
    },
  };
}

const TOKENS = { prompt_tokens: 1000, completion_tokens: 500 };
const FROM_CARD = (1000 * 2 + 500 * 8) / 1e6;

describe("a scripting request's recorded cost", () => {
  test("is what the gateway reported, with the card's figure kept beside it", async () => {
    const { api, work: w } = await work();
    // served at twice the listing, as Grok 4.7 was on OpenRouter's only live provider
    const row = settleScript(api.db, profile, w, await sent({ ...TOKENS, cost: 2 * FROM_CARD }));
    expect(row.cost).toBeCloseTo(2 * FROM_CARD, 12);
    expect(row.costBasis).toBe("provider-reported");
    expect(row.priced?.calculated).toBeCloseTo(FROM_CARD, 12);
    expect(row.priced?.reported).toBeCloseTo(2 * FROM_CARD, 12);
  });

  test("is worked out from the card when the gateway reports none", async () => {
    const { api, work: w } = await work();
    const row = settleScript(api.db, profile, w, await sent(TOKENS));
    expect(row.cost).toBeCloseTo(FROM_CARD, 12);
    expect(row.costBasis).not.toBe("provider-reported");
    expect(row.priced?.reported).toBeNull();
  });
});

describe("a scripting request that reports no usage", () => {
  /** A request that ended without the provider saying what it used. */
  const silent = (over: Partial<SentScript> = {}): SentScript => ({
    startedAt: Date.now(),
    finishedAt: Date.now(),
    attempts: 1,
    rateLimited: false,
    status: "done",
    simulated: false,
    usage: null,
    ...over,
  });

  test("answered, costs what nobody knows — never $0 — and the budgets count what it held", async () => {
    const { api, work: w } = await work();
    const row = settleScript(api.db, profile, { ...w, held: 0.25 }, silent());
    expect(row.cost).toBeNull();
    expect(row.costBasis).toBe("unknown");
    const spend = bookSpend(api.db, w.bookId);
    expect(spend.spent).toBeCloseTo(0.25, 12);
    expect(spend.scriptSpent).toBeCloseTo(0.25, 12);
    expect(spend.unpriced).toBe(1);
    expect(endpointSpend(api.db, "scripting", profile.id, 0)).toBeCloseTo(0.25, 12);
  });

  test("answered with a 2xx this server could not use, is unknown too: the provider billed it", async () => {
    const { api, work: w } = await work();
    const error = { code: 200, message: "the answer was not a script" };
    const row = settleScript(
      api.db,
      profile,
      { ...w, held: 0.25 },
      silent({ status: "failed", error }),
    );
    expect(row.cost).toBeNull();
    expect(bookSpend(api.db, w.bookId).spent).toBeCloseTo(0.25, 12);
  });

  test("refused, costs nothing, as no chat completion is billed for an error", async () => {
    const { api, work: w } = await work();
    const error = { code: 500, message: "upstream down" };
    const row = settleScript(
      api.db,
      profile,
      { ...w, held: 0.25 },
      silent({ status: "failed", error }),
    );
    expect(row.cost).toBe(0);
    expect(row.costBasis).toBe("calculated");
    expect(bookSpend(api.db, w.bookId).spent).toBe(0);
  });

  test("on a card that charges nothing, is known to be free", async () => {
    const { api, work: w } = await work();
    const row = settleScript(
      api.db,
      { ...profile, inPrice: 0, outPrice: 0 },
      { ...w, held: 0 },
      silent(),
    );
    expect(row.cost).toBe(0);
    expect(row.costBasis).toBe("calculated");
  });
});
