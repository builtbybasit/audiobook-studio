// Trying a prompt on one chunk: `POST /api/books/:id/script-trial`. The drafts sent in place of
// what is saved, the chunk cut as a run cuts it, the answer shown and never written — a refused
// one included — and the request priced into the book's ledger and held to its budget.
import { describe, expect, test } from "bun:test";

import type {
  Book,
  BookPrompt,
  ChapterHistory,
  Profile,
  PromptTemplate,
  PromptTrialRequest,
  PromptTrialResult,
  Segment,
} from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SCRIPTING_MODEL } from "@/lib/providers";
import { BUILT_IN_PROMPT } from "@/lib/prompt";
import { characters } from "~/db/schema";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointRequests } from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi } from "../support/server";

interface Failure {
  error: { message: string };
}

/** A gateway at $2 in / $8 out per million tokens, cutting a chapter at 400 characters. */
const gateway = (over: Partial<Profile> = {}): Profile => ({
  id: "gw",
  name: "Gateway",
  model: "some-model",
  inPrice: 2,
  outPrice: 8,
  baseUrl: "http://gateway.test/v1",
  enabled: true,
  concurrency: 1,
  maxChars: 400,
  splitAt: "sentence",
  maxOutputTokens: 4000,
  maxRetries: 0,
  secPerChunk: 1,
  needsKey: false,
  ...over,
});

const simulated = (): Profile =>
  gateway({
    id: "sim",
    name: "Simulated",
    model: SIMULATED_SCRIPTING_MODEL,
    baseUrl: SIMULATED_BASE_URL,
    // whole chapters, answered in a millisecond: a simulated profile's pace is its estimate's tenth
    maxChars: 0,
    secPerChunk: 0.01,
  });

const USAGE = { prompt_tokens: 1000, completion_tokens: 500 };
const FROM_CARD = (1000 * 2 + 500 * 8) / 1e6;

/** Everything the test's templates and the built-in one put before the excerpt. */
const excerptOf = (user: string): string => user.split(/excerpt:\n/i).pop()!;

type Answer = (excerpt: string) => Response;

/** The whole excerpt back as one line of narration: a faithful answer. */
const faithful: Answer = (excerpt) =>
  Response.json({
    choices: [
      {
        message: { content: JSON.stringify({ lines: [{ type: "narration", text: excerpt }] }) },
        finish_reason: "stop",
      },
    ],
    usage: USAGE,
  });

/**
 * A server with one gateway endpoint and one simulated, whose chat requests are answered by
 * `answer` and kept; and a book of one chapter that the gateway cuts into three parts.
 */
async function setup(
  options: { answer?: Answer; prompt?: PromptTemplate; book?: BookPrompt } = {},
) {
  const sent: { system: string; user: string }[] = [];
  let answer = options.answer ?? faithful;
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    const [system, user] = body.messages.map((m) => m.content);
    sent.push({ system, user });
    return answer(excerptOf(user));
  }) as unknown as typeof globalThis.fetch;
  const api = testApi({ scripting: endpointScriptingProvider({ fetch, backoffMs: () => 0 }) });
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      title: "Moonlight Ledger",
      author: "A. Ledger",
      chapters: [{ title: "One", paragraphs: story(6) }],
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  const saved = await api.request("/api/endpoints", {
    ...jsonBody({
      endpoints: [],
      profiles: [gateway(), simulated()],
      credentials: [],
      ...(options.prompt ? { prompt: options.prompt } : {}),
    }),
    method: "PUT",
  });
  expect(saved.status).toBe(200);
  if (options.book) {
    const patched = await api.request(`/api/books/${id}`, {
      ...jsonBody({ prompt: options.book }),
      method: "PATCH",
    });
    expect(patched.status).toBe(200);
  }
  return {
    api,
    id,
    sent,
    answerWith: (a: Answer) => (answer = a),
    trial: <T = PromptTrialResult>(request: Partial<PromptTrialRequest> = {}) =>
      api.request<T>(
        `/api/books/${id}/script-trial`,
        jsonBody({ profile: "gw", chapterId: 1, ...request }),
      ),
  };
}

const LIBRARY: PromptTemplate = {
  system: "Saved library rules.",
  user: "{{chapter.title}}\nExcerpt:\n{{excerpt}}",
};
const SAVED_BOOK: BookPrompt = {
  replace: true,
  notes: "Saved book notes.",
  system: "Saved book rules. {{book.notes}}",
  user: "Excerpt:\n{{excerpt}}",
};

describe("a prompt trial", () => {
  test("sends the saved layers when no draft is given, and the drafts over them", async () => {
    const { trial, sent } = await setup({ prompt: LIBRARY, book: SAVED_BOOK });

    const saved = await trial();
    expect(saved.status).toBe(200);
    expect(saved.body.prompt.system).toStartWith("Saved book rules. Saved book notes.");
    expect(sent[0]).toEqual(saved.body.prompt);

    // the book's draft turns its replacement off and changes its notes; the endpoint's draft
    // replaces the library's prompt with one that places both notes
    const drafted = await trial({
      book: { ...SAVED_BOOK, replace: false, notes: "Draft book notes." },
      profilePrompt: {
        mode: "replace",
        notes: "Draft endpoint notes.",
        system: "Draft endpoint rules. {{endpoint.notes}} {{book.notes}} {{book.title}}",
        user: "{{model}}\nExcerpt:\n{{excerpt}}",
      },
    });
    expect(drafted.body.prompt.system).toStartWith(
      "Draft endpoint rules. Draft endpoint notes. Draft book notes. Moonlight Ledger",
    );
    expect(drafted.body.prompt.user).toStartWith("some-model\nExcerpt:\n");

    // null is a choice: no book prompt, no endpoint prompt, the library's draft
    const library = await trial({
      book: null,
      profilePrompt: null,
      library: { system: "Draft library rules.", user: "Excerpt:\n{{excerpt}}" },
    });
    expect(library.body.prompt.system).toStartWith("Draft library rules.");

    // and null for the library is the built-in prompt
    const builtIn = await trial({ book: null, library: null });
    expect(builtIn.body.prompt.system).toStartWith(BUILT_IN_PROMPT.system.split("\n")[0]);
  });

  test("leaves what is saved as it was", async () => {
    const { api, id, trial } = await setup({ prompt: LIBRARY, book: SAVED_BOOK });
    await trial({ book: null, library: { system: "Draft.", user: "Excerpt:\n{{excerpt}}" } });
    const { body } = await api.request<{ prompt: PromptTemplate | null }>("/api/endpoints");
    expect(body.prompt).toEqual(LIBRARY);
    const book = await api.request<{ book: Book }>(`/api/books/${id}`);
    expect(book.body.book.prompt).toEqual(SAVED_BOOK);
  });

  test("sends the part asked for, cut as the endpoint cuts the chapter", async () => {
    const { trial, sent } = await setup();
    const first = await trial();
    expect(first.body).toMatchObject({ part: 1, parts: 3 });
    const second = await trial({ part: 2 });
    expect(second.body).toMatchObject({ part: 2, parts: 3 });
    expect(second.body.excerpt).not.toBe(first.body.excerpt);
    // sent as the prompt sends it, the chunk's trailing blank line trimmed
    expect(excerptOf(sent[1].user)).toBe(second.body.excerpt.trim());
    expect(second.body.fidelity).toMatchObject({ ok: true, missing: 0, added: 0 });
    expect(second.body.lines).toEqual([
      {
        type: "narration",
        speaker: "Narrator",
        text: second.body.excerpt.replace(/\s+/g, " ").trim(),
      },
    ]);
  });

  test("writes nothing to the script, its history or the cast", async () => {
    const { api, id, trial, answerWith } = await setup();
    answerWith(() =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [{ type: "dialogue", speaker: "Somebody New", text: "Hello" }],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    const history = (
      await api.request<{ history: ChapterHistory }>(`/api/books/${id}/chapters/1/history`)
    ).body;
    const cast = api.db.select().from(characters).all().length;

    const { status, body } = await trial();
    expect(status).toBe(200);
    expect(body.lines).toHaveLength(1);

    const script = await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`);
    expect(script.body.segments).toEqual([]);
    expect(
      (await api.request<{ history: ChapterHistory }>(`/api/books/${id}/chapters/1/history`)).body,
    ).toEqual(history);
    expect(api.db.select().from(characters).all()).toHaveLength(cast);
    const chapter = await api.request<{ chapters: { id: number; scripting: string }[] }>(
      `/api/books/${id}`,
    );
    expect(chapter.body.chapters[0].scripting).toBe("none");
  });

  test("is priced into the book's ledger against the chapter", async () => {
    const { api, id, trial } = await setup();
    const { body } = await trial({ part: 2 });
    const rows = endpointRequests(api.db, "scripting", "gw", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bookId: id,
      chapterId: 1,
      label: "Prompt trial · ch 1 · part 2/3",
      status: "done",
      simulated: false,
    });
    expect(body.cost).toBeCloseTo(FROM_CARD, 12);
    expect(rows[0].cost).toBeCloseTo(FROM_CARD, 12);
    expect(body.usage).toEqual({ inputTokens: 1000, outputTokens: 500, reasoningTokens: null });
    expect(body.ms).toBeGreaterThanOrEqual(0);
  });

  test("reports the reasoning tokens the answer said it spent", async () => {
    const { trial, answerWith } = await setup();
    answerWith((excerpt) =>
      Response.json({
        choices: [
          {
            message: { content: JSON.stringify({ lines: [{ type: "narration", text: excerpt }] }) },
            finish_reason: "stop",
          },
        ],
        usage: { ...USAGE, completion_tokens_details: { reasoning_tokens: 320 } },
      }),
    );
    const { body } = await trial();
    expect(body.usage?.reasoningTokens).toBe(320);
  });

  test("is refused before it is sent when the book's budget cannot take it", async () => {
    const { api, id, trial, sent } = await setup();
    await api.request(`/api/books/${id}`, {
      ...jsonBody({ budget: { cap: 0.000001, paused: false } }),
      method: "PATCH",
    });
    const { status, body } = await trial<Failure>();
    expect(status).toBe(409);
    expect(body.error.message).toMatch(/cap/);
    expect(body.error.message).toContain("this trial");
    expect(sent).toHaveLength(0);
    expect(endpointRequests(api.db, "scripting", "gw", 0)).toHaveLength(0);
  });

  test("shows lines that fail the word check, with the check", async () => {
    const { trial, answerWith } = await setup();
    answerWith((excerpt) => faithful(excerpt.split(" ").slice(0, 10).join(" ")));
    const { status, body } = await trial();
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.lines).toHaveLength(1);
    expect(body.fidelity.ok).toBe(false);
    expect(body.fidelity.missing).toBeGreaterThan(0);
  });

  test("answers a refusal as a result, with no lines, and still prices what was billed", async () => {
    const { api, trial, answerWith } = await setup();
    answerWith(() =>
      Response.json({
        choices: [
          { message: { content: "Sorry, I can't help with that." }, finish_reason: "stop" },
        ],
        usage: USAGE,
      }),
    );
    const { status, body } = await trial();
    expect(status).toBe(200);
    expect(body.error).toMatch(/did not answer with a script \(no JSON object\): “Sorry/);
    expect(body.lines).toEqual([]);
    expect(body.fidelity.ok).toBe(false);
    expect(body.fidelity.missing).toBe(body.fidelity.words);
    expect(body.cost).toBeCloseTo(FROM_CARD, 12);
    expect(endpointRequests(api.db, "scripting", "gw", 0)[0].status).toBe("failed");

    answerWith(() => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
    const refused = await trial();
    expect(refused.body).toMatchObject({
      error: "Gateway answered 401: Invalid API key",
      lines: [],
      usage: null,
      cost: null,
    });
  });

  test("works on a simulated endpoint, which bills nothing and sends nothing", async () => {
    const { api, trial, sent } = await setup();
    const { status, body } = await trial({ profile: "sim" });
    expect(status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(body).toMatchObject({ part: 1, parts: 1, fidelity: { ok: true } });
    expect(body.lines.find((l) => l.type === "dialogue")?.speaker).toBe("Aurelie");
    const [row] = endpointRequests(api.db, "scripting", "sim", 0);
    expect(row).toMatchObject({ simulated: true, label: "Prompt trial · ch 1 · part 1/1" });
  });

  test.each([
    { why: "an unknown endpoint", request: { profile: "nobody" }, status: 404, said: /nobody/ },
    { why: "an unknown chapter", request: { chapterId: 9 }, status: 404, said: /no chapter 9/ },
    { why: "a part past the last", request: { part: 4 }, status: 400, said: /into 3 parts/ },
    {
      why: "a prompt with no excerpt",
      request: { book: null, library: { system: "Rules.", user: "{{chapter.title}}" } },
      status: 400,
      said: /must include \{\{excerpt\}\}/,
    },
    {
      why: "a prompt naming a tag that is not one",
      request: {
        book: null,
        profilePrompt: {
          mode: "replace" as const,
          notes: "",
          system: "{{nonsense}}",
          user: "{{excerpt}}",
        },
      },
      status: 400,
      said: /\{\{nonsense\}\}/,
    },
  ])("refuses $why, sending nothing", async ({ request, status, said }) => {
    const { api, trial, sent } = await setup();
    const res = await trial<Failure>(request);
    expect(res.status).toBe(status);
    expect(res.body.error.message).toMatch(said);
    expect(sent).toHaveLength(0);
    expect(endpointRequests(api.db, "scripting", "gw", 0)).toHaveLength(0);
  });

  test("refuses an unknown book", async () => {
    const { api } = await setup();
    const res = await api.request<Failure>(
      "/api/books/nope/script-trial",
      jsonBody({ profile: "gw", chapterId: 1 }),
    );
    expect(res.status).toBe(404);
  });
});
