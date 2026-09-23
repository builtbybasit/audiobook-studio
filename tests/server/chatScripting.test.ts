// The chat-completions scripting provider, against a fetch that answers as a gateway would: what it
// sends, what it accepts back, and what it refuses — above all an answer that drops the prose.
import { describe, expect, test } from "bun:test";

import { chatScriptingProvider, fidelity, NO_PROFILE } from "~/providers/chatScripting";
import { ProviderError } from "~/providers/http";
import type { ScriptInput, ScriptTarget } from "~/providers/scripting";

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

/** A completion as the gateway sends one: content fenced, reasoning alongside. */
function completion(content: string, finish = "stop"): Response {
  return Response.json({
    choices: [
      {
        message: { role: "assistant", content, reasoning_content: "Thinking about it." },
        finish_reason: finish,
      },
    ],
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
    const lines = await provider.script(input({ progress: (d, t) => seen.push([d, t]) }));
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
    expect(await provider.script(input())).toEqual([
      { type: "narration", speaker: "Narrator", text: "The door opened." },
      { type: "dialogue", speaker: "Mara", text: "Come in," },
      { type: "narration", speaker: "Narrator", text: "said Mara softly." },
    ]);
  });
});

describe("a refusal", () => {
  test("an answer that dropped the prose fails, saying how much", async () => {
    const { provider } = gateway(() => completion(fenced(LINES.slice(0, 2))));
    await expect(provider.script(input())).rejects.toThrow(/left out 3 of 8 words/);
  });

  test("an answer cut off at max output tokens says so", async () => {
    const { provider } = gateway(() => completion('```json\n{"lines":[{"type":', "length"));
    await expect(provider.script(input())).rejects.toThrow(/cut off at max output tokens \(4000\)/);
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
    expect(await provider.script(input())).toHaveLength(3);
    expect(sent).toHaveLength(2);
  });

  test("a profile that needs a key and has none is refused before any request", async () => {
    const { sent, provider } = gateway(() => completion(fenced(LINES)));
    const run = provider.script(input({ target: target({ apiKey: null }) }));
    await expect(run).rejects.toBeInstanceOf(ProviderError);
    await expect(run).rejects.toThrow(/needs an API key/);
    expect(sent).toHaveLength(0);
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
    await expect(provider.script(input({ signal: controller.signal }))).rejects.toBe(reason);
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
