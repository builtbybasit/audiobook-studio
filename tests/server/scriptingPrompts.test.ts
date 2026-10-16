// The scripting prompt on the server: its three layers (library default, endpoint, book) saved,
// refused and read back; runs snapshotting them at queue time; history naming the prompt's source;
// the Test button; and reasoning spend kept in the ledger and fed into the next estimate.
import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import type {
  Book,
  BookPrompt,
  Cast,
  Chapter,
  ChapterHistory,
  Job,
  Profile,
  RequestRecord,
  Segment,
} from "@/types";
import { BUILT_IN_PROMPT, OUTPUT_FORMAT, type PromptCastMember } from "@/lib/prompt";
import { scriptTelemetry } from "@/lib/scriptActivity";
import { chapters, characters, effects, endpoints, requests, segments as lines } from "~/db/schema";
import { profileKey } from "~/db/rows/endpoints";
import { fakeScriptingProvider } from "~/providers/fake";
import type { ScriptInput, ScriptingProvider } from "~/providers/scripting";
import { append, scriptReasoning } from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { gatedProvider, jsonBody, scriptChapters, testApi, type TestApi } from "../support/server";
import { openaiProfile } from "../support/profiles";

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

/**
 * The OpenAI profile's one credential, spelled out: a store test earlier in the process may have
 * refilled the page's registry.
 */
const CREDENTIALS = [{ id: "openai-personal", label: "OpenAI · personal", note: "" }];

const put = <T = Settings>(api: TestApi, body: Record<string, unknown>) =>
  api.request<T>("/api/endpoints", {
    ...jsonBody({
      endpoints: [],
      profiles: [],
      credentials: CREDENTIALS,
      ...body,
    }),
    method: "PUT",
  });

const read = async (api: TestApi) => (await api.request<Settings>("/api/endpoints")).body;

const patchBook = <T = { book: Book }>(api: TestApi, id: string, prompt: BookPrompt | null) =>
  api.request<T>(`/api/books/${id}`, { ...jsonBody({ prompt }), method: "PATCH" });

/** A confirmed book of short chapters: one request each, unless a profile cuts them smaller. */
async function shelved(api: TestApi, titles = ["One"], paragraphs = 2) {
  const { body } = await api.import<{ book: Book; chapters: Chapter[] }>(
    await epubFile({
      title: "Moonlight Ledger",
      author: "A. Ledger",
      chapters: titles.map((title) => ({ title, paragraphs: story(paragraphs) })),
    }),
  );
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  return body.book.id;
}

/**
 * The fake, keeping every request's input; `hold` keeps the first one waiting until `release`, and
 * `thinking` is what each request reports it spent reasoning.
 */
function recording(hold = false, thought?: number) {
  let thinking = thought;
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
      return inner.script({
        ...input,
        sent: (r) =>
          input.sent?.(
            thinking != null && r.usage
              ? { ...r, usage: { ...r.usage, reasoningTokens: thinking } }
              : r,
          ),
      });
    },
    async probe(_target, _signal, prompt) {
      probes.push(prompt);
      return { ok: true, message: "answered", ms: 1 };
    },
  };
  return {
    provider,
    inputs,
    probes,
    first,
    release,
    thinking: (n: number) => (thinking = n),
  };
}

describe("an endpoint's reasoning and prompt", () => {
  test("are kept as they were sent, and a profile without them reads back without them", async () => {
    const api = testApi();
    const prompt = {
      mode: "replace" as const,
      system: "Rules. {{endpoint.notes}}",
      user: "{{excerpt}}",
      notes: "Keep paragraphs apart.",
    };
    const { status } = await put(api, {
      profiles: [
        openaiProfile({ reasoning: "high", prompt }),
        { ...openaiProfile({ id: "bare", name: "Bare" }), reasoning: undefined, prompt: undefined },
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
      prompt: { mode: "replace", system: "Rules.", user: "{{chapter.title}}", notes: "" },
      said: "“OpenAI”'s prompt: The user message must include {{excerpt}}, the text to script.",
    },
    {
      why: "notes over the limit",
      prompt: { mode: "default", system: "", user: "", notes: "x".repeat(4_001) },
      said: "“OpenAI”'s prompt: The notes are 4,001 characters; the most is 4,000.",
    },
    {
      why: "a kept text too long to be sent",
      prompt: { mode: "default", system: "x".repeat(20_001), user: "", notes: "" },
      said: "“OpenAI”'s prompt: The system prompt is 20,001 characters; the most is 20,000.",
    },
  ])("refuses $why, saying what to change", async ({ prompt, said }) => {
    const { status, body } = await put<Failure>(testApi(), {
      profiles: [openaiProfile({ prompt } as Partial<Profile>)],
    });
    expect(status).toBe(400);
    expect(body.error.message).toBe(said);
  });

  test("a default endpoint's kept texts are not held to the rules of a prompt", async () => {
    const prompt = { mode: "default" as const, system: "{{nonsense}}", user: "", notes: "" };
    expect((await put(testApi(), { profiles: [openaiProfile({ prompt })] })).status).toBe(200);
  });

  test("one kept in Append's place reads as default, what it appended now its notes", async () => {
    const api = testApi();
    await put(api, { profiles: [openaiProfile()] });
    api.db
      .update(endpoints)
      .set({
        promptMode: "append" as never,
        promptSystem: "Keep paragraphs apart.",
        promptUser: "Name every speaker.",
      })
      .where(eq(endpoints.id, profileKey("openai")))
      .run();
    expect((await read(api)).profiles[0].prompt).toEqual({
      mode: "default",
      system: "",
      user: "",
      notes: "Keep paragraphs apart.\n\nName every speaker.",
    });
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
      profiles: [openaiProfile()],
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
  const NOTES = {
    mode: "default" as const,
    system: "",
    user: "",
    notes: "Sent to {{endpoint.name}}, kept as typed.",
  };

  test("is the book's replacement, its tags and the endpoint's notes filled in for each request", async () => {
    const rec = recording();
    const api = testApi({ scripting: rec.provider });
    // long enough that the profile's 700 characters cut it into parts
    const id = await shelved(api, ["One"], 6);
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
    // listed though the story never names her: she has a line in the chapter's script now
    api.db
      .insert(lines)
      .values({
        bookId: id,
        chapterId: 1,
        id: 1,
        position: 0,
        type: "dialogue",
        speaker: "Mara",
        text: "Hm.",
        direction: "",
      })
      .run();
    const profile = openaiProfile({
      maxChars: 700,
      splitAt: "sentence",
      concurrency: 1,
      prompt: NOTES,
    });
    await put(api, { profiles: [profile], prompt: LIBRARY });
    await patchBook(api, id, {
      ...BOOK,
      system: `${BOOK.system}\nFor {{endpoint.name}} ({{model}}): {{endpoint.notes}}`,
    });

    const queued = await api.request<{ jobs: Job[] }>(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    await api.runner.idle();

    const parts = rec.inputs.length;
    expect(parts).toBeGreaterThan(1);
    for (const [i, input] of rec.inputs.entries()) {
      expect(input.prompt!.system).toBe(
        `Book rules for Moonlight Ledger by A. Ledger.\nNotes: Mara never shouts.\nFor OpenAI (${profile.model}): Sent to {{endpoint.name}}, kept as typed.\n\n${OUTPUT_FORMAT}`,
      );
      expect(input.prompt!.user).toBe(
        `Part ${i + 1} of ${parts}, chapter 1: One\n- Mara (female; also called M): Keeps the ledger.\n${input.text}`.trim(),
      );
    }

    const origin = { from: "book", fingerprint: expect.any(String) };
    const job = (await api.request<{ job: Job }>(`/api/jobs/${queued.body.jobs[0].id}`)).body.job;
    expect(job.scriptRun?.prompt).toMatchObject({ origin, notes: "Mara never shouts." });
    const { history } = (
      await api.request<{ history: ChapterHistory }>(`/api/books/${id}/chapters/1/history`)
    ).body;
    expect(history.head.origin).toMatchObject({ kind: "scripted", prompt: origin });
    expect(history.head.origin).not.toHaveProperty("prompt.appended");
  });

  test("does not send the endpoint's notes when the prompt has no place for them", async () => {
    const rec = recording();
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api);
    await put(api, { profiles: [openaiProfile({ maxChars: 0, prompt: NOTES })] });
    await patchBook(api, id, BOOK);
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    await api.runner.idle();
    expect(rec.inputs).toHaveLength(1);
    expect(rec.inputs[0].prompt!.system).not.toContain("kept as typed");
  });

  test("is the one the run was queued with, whatever is edited while it waits", async () => {
    const rec = recording(true);
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api, ["One", "Two"]);
    await put(api, { profiles: [openaiProfile({ maxChars: 0 })], prompt: LIBRARY });
    await patchBook(api, id, { notes: "First notes.", replace: false, system: "", user: "" });
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1, 2], profile: "openai" }),
    );

    await rec.first;
    await patchBook(api, id, { notes: "Later notes.", replace: false, system: "", user: "" });
    await put(api, { profiles: [openaiProfile({ maxChars: 0 })], prompt: null });
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

describe("what a model says beside its lines", () => {
  /** Gives every request to Tobiah, and says the same of the cast each time, and a recap. */
  function telling() {
    const inputs: ScriptInput[] = [];
    const provider: ScriptingProvider = {
      name: "Telling (test)",
      async script(input) {
        inputs.push(input);
        return {
          lines: [{ type: "dialogue", speaker: "Tobiah", text: input.text }],
          cast: [
            {
              name: "Tobiah",
              gender: "m",
              aliases: ["the old man", "m"],
              description: "An innkeeper.",
            },
            { name: "Mara", gender: "m", aliases: ["the clerk"], description: "Someone else." },
            { name: "Ghost", gender: "f", aliases: [], description: "Mentioned, never heard." },
          ],
          recap: `Tobiah spoke last, in ${input.title}.`,
        };
      },
    };
    return { provider, inputs };
  }

  test("fills in the cast without overwriting it, and carries the recap to the next chapter", async () => {
    const rec = telling();
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api, ["One", "Two"], 6);
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
    await put(api, {
      profiles: [openaiProfile({ maxChars: 700, splitAt: "sentence", concurrency: 1 })],
    });
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1, 2], profile: "openai" }),
    );
    await api.runner.idle();

    const one = rec.inputs.filter((i) => i.title === "One");
    const two = rec.inputs.filter((i) => i.title === "Two");
    expect(one.length).toBeGreaterThan(1);
    // the first request of the book has nothing before it; every later one of a chapter its prose
    expect(one[0].prompt!.user).not.toContain("left off");
    expect(one[0].prompt!.user).not.toContain("Just before this excerpt");
    const tail = one[0].text
      .trim()
      .split(/\n\s*\n/)
      .at(-1)!
      .replace(/\s+/g, " ");
    expect(one[1].prompt!.user).toContain("(context only, not part of the excerpt): ");
    expect(one[1].prompt!.user).toContain(`${tail}\n\nExcerpt:`);
    // the second chapter opens where the first left off, and knows who Tobiah is by then
    expect(two[0].prompt!.user).toContain(
      "Where the previous chapter left off: Tobiah spoke last, in One.",
    );
    expect(two[0].prompt!.user).toContain("Tobiah (male; also called the old man)");

    const { characters: cast } = (await api.request<Cast>(`/api/books/${id}/cast`)).body;
    const named = (name: string) => cast.find((c) => c.name === name);
    expect(named("Tobiah")).toMatchObject({
      gender: "m",
      // "m" is Mara's already, whatever its case
      aliases: ["the old man"],
      description: "An innkeeper.",
    });
    expect(named("Mara")).toMatchObject({
      gender: "f",
      aliases: ["M", "the clerk"],
      description: "Keeps the ledger.",
    });
    expect(named("Ghost")).toBeUndefined();
    const recap = api.db
      .select({ id: chapters.id, recap: chapters.recap })
      .from(chapters)
      .where(eq(chapters.bookId, id))
      .all();
    expect(recap).toEqual([
      { id: 1, recap: "Tobiah spoke last, in One." },
      { id: 2, recap: "Tobiah spoke last, in Two." },
    ]);
  });
});

describe("personas and line effects", () => {
  test("a persona is marked in the cast, and the line effects named go on the line by id", async () => {
    const inputs: ScriptInput[] = [];
    const provider: ScriptingProvider = {
      name: "Effects (test)",
      async script(input) {
        inputs.push(input);
        return {
          lines: [
            {
              type: "dialogue",
              speaker: "Lord of Shadows",
              text: input.text,
              // any case, each once; a name not offered (the Inner voice has no use-when) is dropped
              effects: ["TELEPHONE", "inner echo", "Telephone", "Inner voice", "Kazoo"],
            },
          ],
        };
      },
    };
    const api = testApi({ scripting: provider });
    const id = await shelved(api);
    api.db
      .insert(characters)
      .values([
        { bookId: id, name: "Sunny", gender: "m", color: "#333" },
        { bookId: id, name: "Lord of Shadows", gender: "m", personaOf: "Sunny", color: "#444" },
        // of nobody in the cast, so of nobody
        { bookId: id, name: "Mask", personaOf: "Nobody", color: "#555" },
      ])
      .run();
    // so a speaker the text never names is listed: Mask has a line in the chapter's script now
    api.db
      .insert(lines)
      .values({
        bookId: id,
        chapterId: 1,
        id: 1,
        position: 0,
        type: "dialogue",
        speaker: "Mask",
        text: "Hm.",
        direction: "",
      })
      .run();
    api.db
      .insert(effects)
      .values([
        {
          id: "phone",
          name: "Telephone",
          chain: [],
          position: 1,
          useWhen: "heard through a phone.",
        },
        { id: "echo", name: "Inner echo", chain: [], position: 2, useWhen: "telepathy" },
      ])
      .run();
    await put(api, { profiles: [openaiProfile({ maxChars: 0 })] });
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    await api.runner.idle();

    const { system, user } = inputs[0].prompt!;
    expect(user).toContain(
      "Known cast: Lord of Shadows (male; persona of Sunny), Mask, Sunny (male)\n",
    );
    expect(system).toContain(
      '- "effects" (optional): sound effects for how this line is heard, by name, only from this list — "Telephone": heard through a phone; "Inner echo": telepathy. Several may apply',
    );
    const { segments } = (
      await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)
    ).body;
    expect(segments.map((s) => s.effects)).toEqual([["phone", "echo"]]);
  });
});

describe("a disguise the model finds", () => {
  /** What the model says of the cast, chapter by chapter, with every line given to `speaker`. */
  function revealing(said: Record<string, { speaker: string; cast: PromptCastMember[] }>) {
    const inputs: ScriptInput[] = [];
    const provider: ScriptingProvider = {
      name: "Revealing (test)",
      async script(input) {
        inputs.push(input);
        const { speaker, cast } = said[input.title];
        return { lines: [{ type: "dialogue", speaker, text: input.text }], cast };
      },
    };
    return { provider, inputs };
  }

  test("is marked masked, linked once the book says who wears it, and never relinked by hand's undoing", async () => {
    const rec = revealing({
      One: {
        speaker: "the Black Mask",
        cast: [
          { name: "the Black Mask", masked: true },
          // an established character is nobody's disguise on the model's say-so
          { name: "Mara", personaOf: "Sunny" },
        ],
      },
      Two: { speaker: "Lord of Shadows", cast: [{ name: "Lord of Shadows", personaOf: "Sunny" }] },
      Three: { speaker: "Aria", cast: [{ name: "the Black Mask", personaOf: "Aria" }] },
      Four: { speaker: "Aria", cast: [{ name: "the Black Mask", personaOf: "Aria" }] },
    });
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api, ["One", "Two", "Three", "Four"]);
    api.db
      .insert(characters)
      .values([
        // the model once filed the disguise as one of Sunny's other names
        { bookId: id, name: "Sunny", gender: "m", aliases: ["Lord of Shadows"], color: "#333" },
        { bookId: id, name: "Mara", gender: "f", color: "#c33" },
      ])
      .run();
    await put(api, { profiles: [openaiProfile({ maxChars: 0 })] });
    const script = async (ids: number[]) => {
      await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids, profile: "openai" }));
      await api.runner.idle();
    };
    const cast = async () =>
      new Map(
        (await api.request<Cast>(`/api/books/${id}/cast`)).body.characters.map((c) => [c.name, c]),
      );

    await script([1, 2]);
    let now = await cast();
    expect(now.get("the Black Mask")).toMatchObject({ masked: true });
    expect(now.get("the Black Mask")?.personaOf).toBeUndefined();
    expect(now.get("Mara")?.personaOf).toBeUndefined();
    expect(now.get("Lord of Shadows")).toMatchObject({ personaOf: "Sunny", masked: true });
    expect(now.get("Sunny")?.aliases).toEqual([]);
    // the next chapter's model is told the mask is still waiting for its wearer
    const two = rec.inputs.find((i) => i.title === "Two")!;
    expect(two.prompt!.user).toContain("the Black Mask (masked, identity unknown)");

    // the reveal adds the wearer, and keeps the mask's own voice (a voice picked meanwhile)
    const mask = { ...now.get("the Black Mask")!, voice: "ep/mask" };
    await api.request(`/api/books/${id}/characters/the%20Black%20Mask`, {
      ...jsonBody(mask),
      method: "PUT",
    });
    expect((await cast()).get("the Black Mask")).toMatchObject({ masked: true, voice: "ep/mask" });
    await script([3]);
    now = await cast();
    expect(now.get("Aria")).toBeDefined();
    expect(now.get("the Black Mask")).toMatchObject({ personaOf: "Aria", masked: true });

    // unlinked by hand: the finding is the person's now, and the next chapter leaves it be
    const { personaOf: _, ...unlinked } = now.get("the Black Mask")!;
    await api.request(`/api/books/${id}/characters/the%20Black%20Mask`, {
      ...jsonBody(unlinked),
      method: "PUT",
    });
    await script([4]);
    now = await cast();
    expect(now.get("the Black Mask")?.personaOf).toBeUndefined();
    expect(now.get("the Black Mask")?.masked).toBeUndefined();
  });
});

describe("a speaker the model names by another of their names", () => {
  test("is the cast member it meant, and what it said of them fills in that member", async () => {
    const provider: ScriptingProvider = {
      name: "Other names (test)",
      async script(input) {
        return {
          lines: [
            { type: "dialogue", speaker: "Hero", text: input.text.slice(0, 20) },
            { type: "dialogue", speaker: "Young Soldier", text: input.text.slice(20) },
          ],
          cast: [{ name: "Hero", description: "A young soldier, steady under fire." }],
        };
      },
    };
    const api = testApi({ scripting: provider });
    const id = await shelved(api);
    api.db
      .insert(characters)
      .values({ bookId: id, name: "Young Soldier", gender: "m", aliases: ["Hero"], color: "#333" })
      .run();
    await put(api, { profiles: [openaiProfile({ maxChars: 0 })] });
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    await api.runner.idle();

    const { characters: cast } = (await api.request<Cast>(`/api/books/${id}/cast`)).body;
    expect(cast.map((c) => c.name)).toEqual(["Young Soldier"]);
    expect(cast[0].description).toBe("A young soldier, steady under fire.");
    const { segments } = (
      await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)
    ).body;
    expect(segments.map((s) => s.speaker)).toEqual(["Young Soldier", "Young Soldier"]);
  });

  test("is one speaker when the same answer's notes say so", async () => {
    const provider: ScriptingProvider = {
      name: "Aliased (test)",
      async script(input) {
        return {
          lines: [
            { type: "dialogue", speaker: "Robert", text: input.text.slice(0, 20) },
            { type: "dialogue", speaker: "Bob", text: input.text.slice(20) },
          ],
          cast: [{ name: "Robert", aliases: ["Bob"] }],
        };
      },
    };
    const api = testApi({ scripting: provider });
    const id = await shelved(api);
    await scriptChapters(api, id, [1]);
    const { characters: cast } = (await api.request<Cast>(`/api/books/${id}/cast`)).body;
    expect(cast.map((c) => c.name)).not.toContain("Bob");
    expect(cast.find((c) => c.name === "Robert")?.aliases).toEqual(["Bob"]);
  });

  test("merged away while a run was out stays merged when it lands", async () => {
    const gate = gatedProvider([{ type: "dialogue", speaker: "Bob", text: "Rain fell." }]);
    const api = testApi({ scripting: gate.provider });
    const id = await shelved(api);
    for (const name of ["Robert", "Bob"])
      api.db.insert(characters).values({ bookId: id, name, gender: "m", color: "#333" }).run();
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
    await gate.started;
    await api.request(
      `/api/books/${id}/characters/merge`,
      jsonBody({ merges: [{ from: "Bob", into: "Robert" }] }),
    );
    gate.release();
    await api.runner.idle();
    const { characters: cast } = (await api.request<Cast>(`/api/books/${id}/cast`)).body;
    expect(cast.map((c) => c.name)).not.toContain("Bob");
    const { segments } = (
      await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)
    ).body;
    expect(segments.map((s) => s.speaker)).toEqual(["Robert"]);
  });
});

describe("the connection test", () => {
  test("asks with the prompt the endpoint's runs would be sent", async () => {
    const rec = recording();
    const api = testApi({ scripting: rec.provider });
    const replaced = { system: "Mine. {{endpoint.notes}}", user: "{{excerpt}}" };
    await put(api, {
      profiles: [
        openaiProfile({ id: "kept", prompt: { mode: "default", ...replaced, notes: "Short." } }),
        openaiProfile({ id: "own", prompt: { mode: "replace", ...replaced, notes: "Short." } }),
      ],
      prompt: LIBRARY,
    });
    for (const id of ["kept", "own"])
      expect(
        (await api.request("/api/endpoints/test", jsonBody({ kind: "scripting", id }))).status,
      ).toBe(200);
    expect(rec.probes).toEqual([
      { template: LIBRARY, notes: "Short." },
      { template: replaced, notes: "Short." },
    ]);
  });
});

describe("what a reasoning model spent thinking", () => {
  test("is kept on each request with the level the run asked for", async () => {
    const rec = recording(false, 120);
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api);
    await put(api, { profiles: [openaiProfile({ maxChars: 0, reasoning: "high" })] });
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    await api.runner.idle();
    const rows = api.db.select().from(requests).where(eq(requests.kind, "scripting")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reasoningTokens: 120, reasoningEffort: "high" });
  });

  test("is added to the output the next run's estimate expects", async () => {
    const rec = recording(false, 0);
    const api = testApi({ scripting: rec.provider });
    const id = await shelved(api);
    await put(api, { profiles: [openaiProfile({ maxChars: 0, reasoning: "high" })] });
    const estimate = async () => {
      const { body } = await api.request<{ jobs: Job[] }>(
        `/api/books/${id}/chapters/script`,
        jsonBody({ ids: [1], profile: "openai" }),
      );
      await api.runner.idle();
      return body.jobs[0].scriptRun!.estimated!;
    };
    // the first run thought for nothing, which is what the second expects
    const first = await estimate();
    expect(await estimate()).toBeCloseTo(first, 12);
    rec.thinking(2000);
    await estimate();
    expect(await estimate()).toBeGreaterThan(first);
  });

  test("is read, per input token, only off answered requests at the endpoint's level now", async () => {
    const api = testApi();
    await put(api, { profiles: [openaiProfile()] });
    const now = Date.now();
    const row = (
      at: number,
      input: number,
      thinking: number | undefined,
      level: "high" | "low" | undefined,
      status: "done" | "failed" = "done",
    ) =>
      append(
        api.db,
        {
          endpointId: "openai",
          kind: "scripting",
          bookId: null,
          label: "Script chunk",
          status,
          attempts: 1,
          queuedAt: now - 1000 + at,
          startedAt: now - 1000 + at,
          finishedAt: now - 1000 + at,
          queueMs: 0,
          responseMs: 10,
          usage: {
            inputTokens: input,
            outputTokens: 50,
            ...(thinking != null ? { reasoningTokens: thinking } : {}),
          },
          ...(level ? { reasoningEffort: level } : {}),
          cost: 0,
          costBasis: "calculated",
          simulated: true,
        },
        null,
      );
    row(1, 1000, 500, "high");
    row(2, 1000, 900, "low");
    row(3, 1000, 300, undefined);
    row(4, 1000, undefined, "high");
    row(5, 1000, 9000, "high", "failed");
    row(6, 3000, 700, "high");

    const high = { perInputToken: 1200 / 4000, requests: 2 };
    expect(scriptReasoning(api.db, { id: "openai", reasoning: "high" })).toEqual(high);
    expect(scriptReasoning(api.db, { id: "openai", reasoning: null })).toEqual({
      perInputToken: 0.3,
      requests: 1,
    });
    expect(scriptReasoning(api.db, { id: "openai", reasoning: "medium" })).toBeNull();

    // the Scripting page reads the same figure off the rows the server sends it
    const { body } = await api.request<{ requests: RequestRecord[] }>(
      "/api/endpoints/requests?kind=scripting&id=openai",
    );
    expect(scriptTelemetry(body.requests, openaiProfile({ reasoning: "high" })).reasoning).toEqual(
      high,
    );
  });
});

describe("the cast a request lists", () => {
  test("is who the chapter names, who spoke just before, and every disguise — not the whole book", async () => {
    const { provider, inputs } = recording();
    const api = testApi({ scripting: provider });
    const id = await shelved(api, ["One", "Two"]);
    api.db
      .insert(characters)
      .values([
        // named in every chapter of the story
        { bookId: id, name: "Aurelie", gender: "f", color: "#111" },
        // spoke in the chapter before
        { bookId: id, name: "Mara", gender: "f", color: "#222" },
        // neither
        { bookId: id, name: "Kel", gender: "m", color: "#333" },
        { bookId: id, name: "the Black Mask", masked: true, color: "#444" },
      ])
      .run();
    api.db
      .insert(lines)
      .values({
        bookId: id,
        chapterId: 1,
        id: 1,
        position: 0,
        type: "dialogue",
        speaker: "Mara",
        text: "Hm.",
        direction: "",
      })
      .run();
    await put(api, { profiles: [openaiProfile({ maxChars: 0 })] });
    await api.request(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [2], profile: "openai" }),
    );
    await api.runner.idle();

    expect(inputs[0].prompt!.user).toContain(
      "Known cast: Aurelie (female), Mara (female), the Black Mask (masked, identity unknown)\n",
    );
  });
});
