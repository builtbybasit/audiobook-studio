// The chat-completions scripting provider, against a fetch that answers as a gateway would: what it
// sends, what it accepts back, and what it refuses — above all an answer that drops the prose.
import { describe, expect, test } from "bun:test";

import type { SegmentType } from "@/types";
import { chatScriptingProvider, fidelity, NO_PROFILE } from "~/providers/chatScripting";
import { ProviderError } from "~/providers/http";
import type { ScriptInput, ScriptTarget } from "~/providers/scripting";
import type { SentScript } from "~/providers/sent";

const TEXT = "The door opened. “Come in,” said Mara softly.";

const LINES = [
  { type: "narration", speaker: "Narrator", text: "The door opened." },
  { type: "dialogue", speaker: "Mara", text: "Come in,", direction: "softly" },
  { type: "narration", speaker: "Narrator", text: "said Mara softly." },
];

const target = (over: Partial<ScriptTarget> = {}): ScriptTarget => ({
  id: "p1",
  name: "Gateway",
  baseUrl: "http://gateway.test/v1",
  model: "some-model",
  apiKey: "sk-test",
  needsKey: true,
  timeoutSec: 5,
  maxRetries: 2,
  cooldownSec: 0,
  maxOutputTokens: 4000,
  ...over,
});

/** What a gateway says a request used, OpenAI-shaped: the cached tokens inside the prompt's. */
const USAGE = {
  prompt_tokens: 1200,
  completion_tokens: 300,
  prompt_tokens_details: { cached_tokens: 1000 },
};

/** A completion as the gateway sends one: content fenced, reasoning alongside. */
function completion(content: string, finish = "stop", usage?: typeof USAGE): Response {
  return Response.json({
    choices: [
      {
        message: { role: "assistant", content, reasoning_content: "Thinking about it." },
        finish_reason: finish,
      },
    ],
    ...(usage ? { usage } : {}),
  });
}
const fenced = (lines: unknown[]): string =>
  "```json\n" + JSON.stringify({ lines }, null, 2) + "\n```";

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that answers from `replies` in turn and remembers every request. */
function gateway(...replies: (() => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
    return reply();
  }) as unknown as typeof globalThis.fetch;
  return { sent, provider: chatScriptingProvider({ fetch, backoffMs: () => 0 }) };
}

/** An input whose reports are kept, for the tests about what reaches the ledger. */
function reported(over: Partial<ScriptInput> = {}) {
  const sent: SentScript[] = [];
  return { sent, input: input({ sent: (r) => sent.push(r), ...over }) };
}

const input = (over: Partial<ScriptInput> = {}): ScriptInput => ({
  title: "Chapter One",
  text: TEXT,
  signal: new AbortController().signal,
  target: target(),
  cast: ["Narrator", "Mara"],
  ...over,
});

describe("the fidelity check", () => {
  test("ignores quotes, case and punctuation, and passes a faithful script", () => {
    const check = fidelity(TEXT, [
      { text: "the door opened" },
      { text: "Come in" },
      { text: "said Mara softly" },
    ]);
    expect(check).toMatchObject({ words: 8, missing: 0, added: 0, ok: true });
  });

  test("counts what went missing and what was made up", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const kept = words.split(" ").slice(0, 95).join(" ");
    const check = fidelity(words, [{ text: kept + " invented" }]);
    expect(check).toMatchObject({ words: 100, missing: 5, added: 1, ok: false });
    expect(check.examples).toHaveLength(5);
    // two in a hundred is the tolerance
    expect(fidelity(words, [{ text: words.split(" ").slice(0, 98).join(" ") }]).ok).toBe(true);
  });
});

describe("a request", () => {
  test("goes to /chat/completions with the model, the key and the output cap, and the fenced answer is read", async () => {
    const { sent, provider } = gateway(() => completion(fenced(LINES)));
    const seen: [number, number][] = [];
    const { lines } = await provider.script(input({ progress: (d, t) => seen.push([d, t]) }));
    expect(lines).toEqual([
      { type: "narration", speaker: "Narrator", text: "The door opened." },
      { type: "dialogue", speaker: "Mara", text: "Come in,", direction: "softly" },
      { type: "narration", speaker: "Narrator", text: "said Mara softly." },
    ]);
    expect(seen).toEqual([
      [0, 1],
      [1, 1],
    ]);
    const [req] = sent;
    expect(req.url).toBe("http://gateway.test/v1/chat/completions");
    expect(req.headers.get("authorization")).toBe("Bearer sk-test");
    expect(req.body).toMatchObject({
      model: "some-model",
      max_tokens: 4000,
      response_format: { type: "json_object" },
    });
    const user = (req.body.messages as { content: string }[])[1].content;
    expect(user).toContain("Known cast: Mara");
    expect(user).toContain(TEXT);
  });

  test("reports what the completion said it used, once, as a request that was not simulated", async () => {
    const { provider } = gateway(() => completion(fenced(LINES), "stop", USAGE));
    const { sent, input } = reported();
    await provider.script(input);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      status: "done",
      attempts: 1,
      rateLimited: false,
      simulated: false,
      usage: { inputTokens: 1200, cachedInput: 1000, outputTokens: 300, format: "openai" },
    });
    expect(sent[0].error).toBeUndefined();
  });

  test("carries the cost a gateway reports beside the tokens, as OpenRouter does", async () => {
    const { provider } = gateway(() =>
      Response.json({
        choices: [{ message: { content: fenced(LINES) }, finish_reason: "stop" }],
        usage: { ...USAGE, cost: 0.00123, cost_details: { upstream_inference_cost: null } },
      }),
    );
    const { sent, input } = reported();
    await provider.script(input);
    expect(sent[0].usage).toMatchObject({ inputTokens: 1200, reportedCost: 0.00123 });
  });

  test("carries no key when none is needed, and no cap when the profile sets none", async () => {
    const { sent, provider } = gateway(() => completion(JSON.stringify({ lines: LINES })));
    await provider.script(
      input({ target: target({ apiKey: null, needsKey: false, maxOutputTokens: 0 }) }),
    );
    expect(sent[0].headers.get("authorization")).toBeNull();
    expect(sent[0].body.max_tokens).toBeUndefined();
  });

  test("tidies a loosely-shaped answer: quotes, odd types and empty lines", async () => {
    const { provider } = gateway(() =>
      completion(
        fenced([
          { type: "Narration", speaker: "", text: "The door opened." },
          { type: "speech", speaker: "Mara", text: "“Come in,”" },
          { type: "narration", speaker: "Narrator", text: "  " },
          { type: "whatever", speaker: "Narrator", text: "said Mara softly." },
        ]),
      ),
    );
    expect((await provider.script(input())).lines).toEqual([
      { type: "narration", speaker: "Narrator", text: "The door opened." },
      { type: "dialogue", speaker: "Mara", text: "Come in," },
      { type: "narration", speaker: "Narrator", text: "said Mara softly." },
    ]);
  });

  test("reads what the answer says of the cast and where it leaves off, and drops what it cannot", async () => {
    const { provider } = gateway(() =>
      completion(
        JSON.stringify({
          lines: LINES,
          cast: [
            {
              name: " Mara ",
              gender: "Female",
              aliases: ["the lamplighter", "Mara", "the lamplighter"],
              description: "A young  lamplighter.",
            },
            { name: "Tobiah", gender: "man" },
            { name: "Kit", gender: "non-binary", aliases: null },
            { name: "Narrator", gender: "male" },
            { name: "Unknown" },
            { gender: "female" },
            "Mara is a girl",
          ],
          recap: "Mara  let a stranger in;\nshe spoke last.",
        }),
      ),
    );
    const answer = await provider.script(input());
    expect(answer.lines).toHaveLength(3);
    expect(answer.cast).toEqual([
      {
        name: "Mara",
        gender: "f",
        aliases: ["the lamplighter"],
        description: "A young lamplighter.",
      },
      { name: "Tobiah", gender: "m", aliases: [], description: "" },
      { name: "Kit", gender: "n", aliases: [], description: "" },
    ]);
    expect(answer.recap).toBe("Mara let a stranger in; she spoke last.");
  });

  test("an answer with a cast and recap it cannot read is still a script", async () => {
    const { provider } = gateway(() =>
      completion(JSON.stringify({ lines: LINES, cast: "Mara", recap: { who: "Mara" } })),
    );
    const answer = await provider.script(input());
    expect(answer).toEqual({ lines: expect.any(Array), cast: [] });
  });

  // the words stay in the script, so the prose read here carries the site's line and the note too
  test.each<[string, SegmentType]>([
    ["watermark", "watermark"],
    ["site", "watermark"],
    ["Boilerplate", "watermark"],
    ["ad", "watermark"],
    ["note", "note"],
    ["TL note", "note"],
    ["translator note", "note"],
    ["author note", "note"],
    ["A/N", "note"],
  ])("reads a line typed “%s” as %s, and gives it to the Narrator", async (said, type) => {
    const text = "Read more at example.com. The door opened.";
    const { provider } = gateway(() =>
      completion(
        fenced([
          { type: said, speaker: "Mara", text: "“Read more at example.com.”" },
          { type: "narration", speaker: "Narrator", text: "The door opened." },
        ]),
      ),
    );
    const {
      lines: [marked],
    } = await provider.script(input({ text }));
    // not a character's line, so no quotation marks are taken off it either
    expect(marked).toEqual({ type, speaker: "Narrator", text: "“Read more at example.com.”" });
  });
});

describe("a refusal", () => {
  test("an answer that dropped the prose fails, saying how much", async () => {
    const { provider } = gateway(() => completion(fenced(LINES.slice(0, 2))));
    await expect(provider.script(input())).rejects.toThrow(/left out 3 of 8 words/);
  });

  test("an answer cut off at max output tokens says so, and is reported failed with what it used", async () => {
    const { provider } = gateway(() => completion('```json\n{"lines":[{"type":', "length", USAGE));
    const { sent, input } = reported();
    await expect(provider.script(input)).rejects.toThrow(/cut off at max output tokens \(4000\)/);
    // the model wrote those tokens and they are billed, whatever became of the script
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      status: "failed",
      usage: { inputTokens: 1200, outputTokens: 300 },
      error: { code: 200, message: expect.stringMatching(/cut off at max output tokens/) },
    });
  });

  test("a server fault that outlasts the retries is reported failed, with every attempt and no usage", async () => {
    const { sent: wire, provider } = gateway(() => new Response("upstream down", { status: 500 }));
    const { sent, input } = reported();
    await expect(provider.script(input)).rejects.toThrow("Gateway answered 500: upstream down");
    expect(wire).toHaveLength(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      status: "failed",
      attempts: 3,
      usage: null,
      error: { code: 500, message: "Gateway answered 500: upstream down" },
    });
  });

  test("an answer that is not a script is quoted back", async () => {
    const { provider } = gateway(() => completion("Sorry, I can't help with that."));
    await expect(provider.script(input())).rejects.toThrow(/did not answer with a script: “Sorry/);
  });

  test("a 401 is not retried, and reads as the gateway's own words", async () => {
    const { sent, provider } = gateway(() =>
      Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    );
    await expect(provider.script(input())).rejects.toThrow("Gateway answered 401: Invalid API key");
    expect(sent).toHaveLength(1);
  });

  test("a 429 is waited out and tried again", async () => {
    const { sent, provider } = gateway(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      () => completion(fenced(LINES)),
    );
    const report = reported();
    expect((await provider.script(report.input)).lines).toHaveLength(3);
    expect(sent).toHaveLength(2);
    expect(report.sent).toMatchObject([{ status: "done", attempts: 2, rateLimited: true }]);
  });

  test("a profile that needs a key and has none is refused before any request", async () => {
    const { sent, provider } = gateway(() => completion(fenced(LINES)));
    const report = reported({ target: target({ apiKey: null }) });
    const run = provider.script(report.input);
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    await expect(run).rejects.toThrow(/needs an API key/);
    expect(sent).toHaveLength(0);
    // nothing went out, so there is nothing to bill
    expect(report.sent).toEqual([]);
  });

  test("a run with no profile is refused before any request", async () => {
    const { sent, provider } = gateway(() => completion(fenced(LINES)));
    await expect(provider.script(input({ target: null }))).rejects.toThrow(NO_PROFILE);
    expect(sent).toHaveLength(0);
  });

  test("a cancel mid-request rejects with the job's reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        controller.abort(reason);
      })) as unknown as typeof globalThis.fetch;
    const provider = chatScriptingProvider({ fetch, backoffMs: () => 0 });
    const report = reported({ signal: controller.signal });
    await expect(provider.script(report.input)).rejects.toBe(reason);
    // what the provider made of a request dropped halfway is not knowable, so nothing is claimed
    expect(report.sent).toEqual([]);
  });
});

describe("a lenient request (a prompt trial)", () => {
  test("hands back lines that fail the word check, reported as answered", async () => {
    const { provider } = gateway(() => completion(fenced(LINES.slice(0, 2)), "stop", USAGE));
    const { sent, input } = reported({ lenient: true });
    const { lines } = await provider.script(input);
    expect(lines).toHaveLength(2);
    expect(fidelity(TEXT, lines)).toMatchObject({ ok: false, missing: 3 });
    expect(sent).toMatchObject([{ status: "done", usage: { inputTokens: 1200 } }]);
  });

  test("still refuses an answer that is not a script, or was cut off", async () => {
    const chat = gateway(() => completion("Sorry, I can't help with that."));
    await expect(chat.provider.script(input({ lenient: true }))).rejects.toThrow(
      /did not answer with a script/,
    );
    const cut = gateway(() => completion('```json\n{"lines":[{"type":', "length", USAGE));
    await expect(cut.provider.script(input({ lenient: true }))).rejects.toThrow(
      /cut off at max output tokens/,
    );
  });
});

describe("a request's reasoning tokens", () => {
  test("ride on the usage it reports", async () => {
    const { provider } = gateway(() =>
      Response.json({
        choices: [{ message: { content: fenced(LINES) }, finish_reason: "stop" }],
        usage: { ...USAGE, completion_tokens_details: { reasoning_tokens: 120 } },
      }),
    );
    const { sent, input } = reported();
    await provider.script(input);
    expect(sent[0].usage?.reasoningTokens).toBe(120);
  });
});

describe("the Test button", () => {
  test("answers ok with how long it took and who spoke", async () => {
    const { provider } = gateway(() =>
      completion(
        fenced([
          { type: "narration", speaker: "Narrator", text: "The lamp guttered in the draught." },
          { type: "dialogue", speaker: "Mara", text: "Is someone there?", direction: "whispering" },
          { type: "narration", speaker: "Narrator", text: "Mara whispered." },
        ]),
      ),
    );
    const result = await provider.probe!(target(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Answered in \d+ ms with 3 lines, spoken by Mara$/);
  });

  test("answers not ok, never throws, on a refusal", async () => {
    const { provider } = gateway(() => new Response("nope", { status: 403 }));
    const result = await provider.probe!(target(), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, message: "Gateway answered 403: nope" });
  });
});

describe("a reasoning level", () => {
  test("none set sends today's request: temperature, and no reasoning field", async () => {
    const { sent, provider } = gateway(() => completion(fenced(LINES)));
    await provider.script(input({ target: target({ baseUrl: "https://openrouter.ai/api/v1" }) }));
    await provider.script(input({ target: target({ baseUrl: "https://api.openai.com/v1" }) }));
    expect(sent[0].body.temperature).toBe(0.1);
    expect(Object.keys(sent[0].body).sort()).toEqual(
      ["max_tokens", "messages", "model", "response_format", "temperature"].sort(),
    );
    // GPT-6 reasons by default, and refuses a temperature while it does
    expect(Object.keys(sent[1].body)).not.toContain("temperature");
  });

  test("is sent as the host spells it, and temperature is left out where the host refuses it", async () => {
    const { sent, provider } = gateway(() => completion(fenced(LINES)));
    const at = (baseUrl: string, reasoning: "off" | "low" | "medium" | "high") =>
      provider.script(input({ target: target({ baseUrl, reasoning }) }));
    await at("https://api.openai.com/v1", "low");
    await at("https://openrouter.ai/api/v1", "off");
    await at("https://api.deepseek.com", "off");
    expect(sent[0].body).toMatchObject({ reasoning_effort: "low" });
    expect(sent[0].body.temperature).toBeUndefined();
    expect(sent[1].body).toMatchObject({ reasoning: { effort: "none" }, temperature: 0.1 });
    expect(sent[2].body).toMatchObject({ thinking: { type: "disabled" }, temperature: 0.1 });
  });

  test("a cut-off answer suggests a lower level when one was asked for", async () => {
    const { provider } = gateway(() => completion('{"lines":[', "length"));
    await expect(provider.script(input({ target: target({ reasoning: "high" }) }))).rejects.toThrow(
      /raise it or lower the reasoning level on the Endpoints page/,
    );
    await expect(provider.script(input({ target: target({ reasoning: "off" }) }))).rejects.toThrow(
      /raise it on the Endpoints page \(a reasoning model/,
    );
  });

  test("the Test button counts the reasoning tokens, and shrugs off a malformed usage block", async () => {
    const probeLines = fenced([
      { type: "narration", speaker: "Narrator", text: "The lamp guttered in the draught." },
      { type: "dialogue", speaker: "Mara", text: "Is someone there?" },
      { type: "narration", speaker: "Narrator", text: "Mara whispered." },
    ]);
    const answer = (usage: unknown) => () =>
      Response.json({
        choices: [{ message: { content: probeLines }, finish_reason: "stop" }],
        usage,
      });
    const probe = async (usage: unknown, reasoning: "off" | null = null) =>
      (
        await gateway(answer(usage)).provider.probe!(
          target({ reasoning }),
          new AbortController().signal,
        )
      ).message;
    const details = (n: unknown) => ({
      ...USAGE,
      completion_tokens_details: { reasoning_tokens: n },
    });
    expect(await probe(details(212))).toMatch(
      /^Answered in \d+ ms with 3 lines, spoken by Mara; 212 reasoning tokens$/,
    );
    // none spent is worth saying only to someone who turned reasoning off
    expect(await probe(details(0))).toMatch(/spoken by Mara$/);
    expect(await probe(details(0), "off")).toMatch(/; 0 reasoning tokens$/);
    expect(await probe(details("lots"))).toMatch(/spoken by Mara$/);
    expect(await probe({ completion_tokens_details: null })).toMatch(/spoken by Mara$/);
  });
});
