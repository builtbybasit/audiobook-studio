// The scripting prompt on the server: the three places it is kept — the library's default, an
// endpoint's say over it, a book's notes and replacement — saved, refused and read back; a run
// snapshotting the layers resolved when it is queued and filling in each request's tags; the
// chapter's history naming where its prompt came from; and the Test button asking with the prompt
// the profile's runs would be sent.
import { describe, expect, test } from "bun:test";

import type { Book, BookPrompt, Chapter, ChapterHistory, Job, Profile } from "@/types";
import { credentials } from "@/lib/credentials";
import { BUILT_IN_PROMPT, OUTPUT_FORMAT } from "@/lib/prompt";
import { makeProfiles } from "@/mock/fixtures/profiles";
import { characters } from "~/db/schema";
import { fakeScriptingProvider } from "~/providers/fake";
import type { ScriptInput, ScriptingProvider } from "~/providers/scripting";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

interface Settings {
  profiles: Profile[];
  prompt: { system: string; user: string } | null;
}
interface Failure {
  error: { message: string };
}

const LIBRARY = {
  system: "Library rules. Notes: {{book.notes}}",
  user: "{{chapter.title}}\n{{excerpt}}",
};

/** The seeded OpenAI profile, with whatever this test gives it. */
const openai = (over: Partial<Profile> = {}): Profile => ({
  ...makeProfiles().find((p) => p.id === "openai")!,
  ...over,
});

const put = <T = Settings>(api: TestApi, body: Record<string, unknown>) =>
  api.request<T>("/api/endpoints", {
    ...jsonBody({
      endpoints: [],
      profiles: [],
      credentials: credentials.map((c) => ({ ...c })),
      ...body,
    }),
    method: "PUT",
  });

const read = async (api: TestApi) => (await api.request<Settings>("/api/endpoints")).body;

const patchBook = <T = { book: Book }>(api: TestApi, id: string, prompt: BookPrompt | null) =>
  api.request<T>(`/api/books/${id}`, { ...jsonBody({ prompt }), method: "PATCH" });

async function shelved(api: TestApi, titles = ["One"]) {
  const { body } = await api.import<{ book: Book; chapters: Chapter[] }>(
    await epubFile({
      title: "Moonlight Ledger",
      author: "A. Ledger",
      chapters: titles.map((title) => ({ title, paragraphs: story(12) })),
    }),
  );
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  return body.book.id;
}

/** The fake, keeping every request's input; `hold` keeps the first one waiting until `release`. */
function recording(hold = false) {
  const inner = fakeScriptingProvider();
  const inputs: ScriptInput[] = [];
  const probes: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const first = new Promise<void>((r) => (started = r));
  const provider: ScriptingProvider = {
    name: inner.name,
    async script(input) {
      inputs.push(input);
      if (inputs.length === 1) {
        started();
        if (hold) await gate;
      }
      return inner.script(input);
    },
    async probe(_target, _signal, prompt) {
      probes.push(prompt);
      return { ok: true, message: "answered", ms: 1 };
    },
  };
  return { provider, inputs, probes, first, release };
}

describe("an endpoint's reasoning and prompt", () => {
  test("are kept as they were sent, and a profile without them reads back without them", async () => {
    const api = testApi();
    const prompt = { mode: "append" as const, system: "Keep paragraphs apart.", user: "" };
    const { status } = await put(api, {
      profiles: [
        openai({ reasoning: "high", prompt }),
        { ...openai({ id: "bare", name: "Bare" }), reasoning: undefined, prompt: undefined },
      ],
    });
    expect(status).toBe(200);
    const [kept, bare] = (await read(api)).profiles;
    expect(kept).toMatchObject({ reasoning: "high", prompt });
    // a filled-in profile's null reasoning is a setting, "leave it to the model"
    expect(bare.reasoning).toBeNull();
    expect(bare).not.toHaveProperty("prompt");
  });

  test.each([
    {
      why: "a replacement without {{excerpt}}",
      prompt: { mode: "replace", system: "Rules.", user: "{{chapter.title}}" },
      said: "“OpenAI”'s prompt: The user message must include {{excerpt}}, the text to script.",
    },
    {
      why: "an addition that brings a second excerpt",
      prompt: { mode: "append", system: "", user: "{{excerpt}}" },
      said: "“OpenAI”'s prompt: An addition must not include {{excerpt}}: the prompt it adds to already has it.",
    },
    {
      why: "a kept text too long to be sent",
      prompt: { mode: "default", system: "x".repeat(20_001), user: "" },
      said: "“OpenAI”'s prompt: The system prompt is 20,001 characters; the most is 20,000.",
    },
  ])("refuses $why, saying what to change", async ({ prompt, said }) => {
    const { status, body } = await put<Failure>(testApi(), {
      profiles: [openai({ prompt } as Partial<Profile>)],
    });
    expect(status).toBe(400);
    expect(body.error.message).toBe(said);
  });

  test("a default endpoint's kept texts are not held to the rules of a prompt", async () => {
    const prompt = { mode: "default" as const, system: "{{nonsense}}", user: "" };
    expect((await put(testApi(), { profiles: [openai({ prompt })] })).status).toBe(200);
  });
});

describe("the library's prompt", () => {
  test("is read back as saved; a save that leaves it out keeps it, and null resets it", async () => {
    const api = testApi();
    expect((await read(api)).prompt).toBeNull();
    await put(api, { prompt: LIBRARY });
    expect((await read(api)).prompt).toEqual(LIBRARY);
    await put(api, {});
    expect((await read(api)).prompt).toEqual(LIBRARY);
    await put(api, { prompt: null });
    expect((await read(api)).prompt).toBeNull();
  });

  test("with a tag that is not one is refused, and nothing of the save is kept", async () => {
    const api = testApi();
    const { status, body } = await put<Failure>(api, {
      profiles: [openai()],
      prompt: { system: "{{book.genre}}", user: "{{excerpt}}" },
    });
    expect(status).toBe(400);
    expect(body.error.message).toBe(
      "The library's prompt: The system prompt names {{book.genre}}, which is not a tag.",
    );
    expect(await read(api)).toMatchObject({ profiles: [], prompt: null });
  });
});

describe("a book's prompt", () => {
  test("is kept with the book, kept off while it is not the book's whole prompt, and null clears it", async () => {
    const api = testApi();
    const id = await shelved(api);
    const prompt = { notes: "Mara never shouts.", replace: false, system: "", user: "no excerpt" };
    const set = await patchBook(api, id, prompt);
    expect(set.status).toBe(200);
    expect(set.body.book.prompt).toEqual(prompt);
    expect((await api.request<{ book: Book }>(`/api/books/${id}`)).body.book.prompt).toEqual(
      prompt,
    );
    const cleared = await patchBook(api, id, null);
    expect(cleared.body.book).not.toHaveProperty("prompt");
  });

  test.each([
    {
      why: "notes over the limit",
      prompt: { notes: "x".repeat(4_001), replace: false, system: "", user: "" },
      said: "The book's prompt: The notes are 4,001 characters; the most is 4,000.",
    },
    {
      why: "a replacement without {{excerpt}}",
      prompt: { notes: "", replace: true, system: "Rules.", user: "" },
      said: "The book's prompt: The user message must include {{excerpt}}, the text to script.",
    },
  ])("refuses $why", async ({ prompt, said }) => {
    const api = testApi();
    const id = await shelved(api);
    const { status, body } = await patchBook<Failure>(api, id, prompt);
    expect(status).toBe(400);
    expect(body.error.message).toBe(said);
  });
});

describe("a run's prompt", () => {
  const BOOK: BookPrompt = {
    notes: "Mara never shouts.",
    replace: true,
    system: "Book rules for {{book.title}} by {{book.author}}.\nNotes: {{book.notes}}",
    user: "Part {{part}} of {{parts}}, chapter {{chapter.number}}: {{chapter.title}}\n{{cast.details}}\n{{excerpt}}",
  };
  const APPEND = {
    mode: "append" as const,
    system: "Sent to {{endpoint.name}} ({{model}}).",
    user: "",
  };

  test("is the book's replacement with the endpoint's addition, its tags filled in for each request", async () => {
    const rec = recording();
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api);
    api.db
      .insert(characters)
      .values({
        bookId: id,
        name: "Mara",
        aliases: ["M"],
        gender: "f",
        description: "Keeps the ledger.",
        color: "#c33",
      })
      .run();
    const profile = openai({ maxChars: 700, splitAt: "sentence", concurrency: 1, prompt: APPEND });
    await put(api, { profiles: [profile], prompt: LIBRARY });
    await patchBook(api, id, BOOK);

    const queued = await api.request<{ jobs: Job[] }>(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    await api.runner.idle();

    const parts = rec.inputs.length;
    expect(parts).toBeGreaterThan(1);
    for (const [i, input] of rec.inputs.entries()) {
      expect(input.prompt!.system).toBe(
        `Book rules for Moonlight Ledger by A. Ledger.\nNotes: Mara never shouts.\n\nSent to OpenAI (${profile.model}).\n\n${OUTPUT_FORMAT}`,
      );
      expect(input.prompt!.user).toBe(
        `Part ${i + 1} of ${parts}, chapter 1: One\n- Mara (female; also called M): Keeps the ledger.\n${input.text}`.trim(),
      );
    }

    const origin = { from: "book", appended: true, fingerprint: expect.any(String) };
    const job = (await api.request<{ job: Job }>(`/api/jobs/${queued.body.jobs[0].id}`)).body.job;
    expect(job.scriptRun?.prompt).toMatchObject({ origin, notes: "Mara never shouts." });
    const { history } = (
      await api.request<{ history: ChapterHistory }>(`/api/books/${id}/chapters/1/history`)
    ).body;
    expect(history.head.origin).toMatchObject({ kind: "scripted", prompt: origin });
  });

  test("is the one the run was queued with, whatever is edited while it waits", async () => {
    const rec = recording(true);
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api, ["One", "Two"]);
    await put(api, { profiles: [openai({ maxChars: 0 })], prompt: LIBRARY });
    await patchBook(api, id, { notes: "First notes.", replace: false, system: "", user: "" });
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1, 2], profile: "openai" }),
    );

    await rec.first;
    await patchBook(api, id, { notes: "Later notes.", replace: false, system: "", user: "" });
    await put(api, { profiles: [openai({ maxChars: 0 })], prompt: null });
    rec.release();
    await api.runner.idle();

    expect(rec.inputs.map((i) => i.prompt!.system.split("\n\n")[0])).toEqual([
      "Library rules. Notes: First notes.",
      "Library rules. Notes: First notes.",
    ]);
  });

  test("is the built-in one for a run queued before prompts could be edited", async () => {
    const rec = recording();
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api);
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
    await api.runner.idle();
    expect(rec.inputs[0].prompt!.system).toStartWith(BUILT_IN_PROMPT.system.split("\n")[0]);
    expect(rec.inputs[0].prompt!.system).not.toContain("Notes on this book");
  });
});

describe("the connection test", () => {
  test("asks with the library's prompt and the endpoint's addition", async () => {
    const rec = recording();
    const api = testApi({ scripting: rec.provider });
    await put(api, {
      profiles: [
        openai({ prompt: { mode: "append", system: "Keep paragraphs apart.", user: "" } }),
      ],
      prompt: LIBRARY,
    });
    const { status } = await api.request(
      "/api/endpoints/test",
      jsonBody({ kind: "scripting", id: "openai" }),
    );
    expect(status).toBe(200);
    expect(rec.probes).toEqual([
      { system: `${LIBRARY.system}\n\nKeep paragraphs apart.`, user: LIBRARY.user },
    ]);
  });
});
