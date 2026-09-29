// The scripting prompt and reasoning level on the endpoints side: what an endpoint may be set to,
// what its estimate counts the prompt at, and how the library's default travels with the rest of
// the configuration — kept as null while it is the built-in prompt, saved only when it is a whole
// prompt, and carried by a settings file.
//
// The service is a fake that keeps the document in memory, as in `endpointsBackend.test.ts`; how
// the server stores and checks the prompt is `tests/server/`'s.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { BUILT_IN_PROMPT, NOTES_MAX_CHARS, promptOverhead } from "@/lib/prompt";
import { newProfile, profileErrors, reasoningEstimateNote, tokenEstimate } from "@/lib/scripting";
import { clone } from "@/lib/utils";
import {
  setEndpointSettingsService,
  type EndpointConfig,
  type EndpointSettings,
  type EndpointSettingsService,
} from "@/services/endpointSettings";
import { useEndpointsStore, WRITE_DELAY_MS } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import type { Profile, PromptTemplate, SettingsFile } from "@/types";
import { testPinia, type TestPinia } from "./support/pinia";

const OWN: PromptTemplate = {
  system: "You script novels for radio.",
  user: "Chapter {{chapter.title}}\n\n{{excerpt}}",
};

// ---------------------------------------------------------------------------------------------
// The profile

describe("a scripting endpoint's prompt and reasoning level", () => {
  test("a new profile leaves reasoning to the model and has no prompt, and keeps both when given", () => {
    const p = newProfile();
    expect(p.reasoning).toBeNull();
    expect(p.prompt).toBeUndefined();
    const q = newProfile({
      model: "m",
      reasoning: "low",
      prompt: { mode: "default", system: "", user: "", notes: "Keep paragraphs apart." },
    });
    expect(q.reasoning).toBe("low");
    expect(q.prompt).toEqual({
      mode: "default",
      system: "",
      user: "",
      notes: "Keep paragraphs apart.",
    });
    expect(profileErrors(q)).toEqual([]);
  });

  test("a prompt written before notes comes in as it is kept now: an Append as the notes", () => {
    const old = (prompt: unknown) => newProfile({ model: "m", prompt } as Partial<Profile>).prompt;
    expect(
      old({ mode: "append", system: " Keep paragraphs apart. ", user: "No summaries." }),
    ).toEqual({
      mode: "default",
      system: "",
      user: "",
      notes: "Keep paragraphs apart.\n\nNo summaries.",
    });
    expect(old({ mode: "replace", ...OWN })).toEqual({ mode: "replace", ...OWN, notes: "" });
  });

  test("only the mode in use is checked", () => {
    const p = newProfile({ model: "m" });
    // a replacement must be a prompt of its own…
    p.prompt = {
      mode: "replace",
      system: "Script it.",
      user: "Chapter {{chapter.title}}",
      notes: "",
    };
    expect(profileErrors(p)).toEqual([
      "Prompt: The user message must include {{excerpt}}, the text to script.",
    ]);
    // …a Default endpoint's kept text is not sent, so it is not held against it…
    p.prompt = { mode: "default", system: "{{nonsense}}", user: "", notes: "" };
    expect(profileErrors(p)).toEqual([]);
    p.prompt = { mode: "replace", ...OWN, notes: "" };
    expect(profileErrors(p)).toEqual([]);
    // …and the notes are held to their length whatever the mode
    p.prompt = { mode: "default", system: "", user: "", notes: "x".repeat(NOTES_MAX_CHARS + 1) };
    expect(profileErrors(p)).toHaveLength(1);
  });

  test("an unknown reasoning level or a malformed prompt is refused", () => {
    const p = newProfile({ model: "m" });
    (p as { reasoning: unknown }).reasoning = "extreme";
    expect(profileErrors(p)).toEqual(["Choose a valid reasoning level."]);
    p.reasoning = "off";
    (p as { prompt: unknown }).prompt = { mode: "sideways", system: "", user: "" };
    expect(profileErrors(p)).toEqual(["Invalid prompt settings."]);
  });

  test("the estimate counts the prompt it is given, and 500 tokens without one", () => {
    const p = newProfile({ model: "m", inPrice: 1, outPrice: 2 });
    const text = "x".repeat(4000);
    const at = Date.UTC(2026, 0, 1);
    const bare = tokenEstimate(text, p, at);
    expect(bare.inputTokens).toBe(1600 + 500);
    const long: PromptTemplate = { system: OWN.system + "y".repeat(8000), user: OWN.user };
    const withPrompt = tokenEstimate(text, p, at, { prompt: long });
    expect(withPrompt.inputTokens).toBe(1600 + Math.ceil(promptOverhead(long) / 4));
    // eight thousand characters more than the built-in prompt's system message is about 2,000
    // tokens more, less what the flat 500 undercounted the built-in one by
    expect(withPrompt.inputTokens).toBeGreaterThan(bare.inputTokens + 1500);
    // the output side does not depend on the prompt
    expect(withPrompt.outputTokens).toBe(bare.outputTokens);
    expect(withPrompt.inputCost).toBeCloseTo((withPrompt.inputTokens * 1) / 1e6, 12);
  });

  test("the estimate adds the thinking seen per input token to the output, and the reservation stays the ceiling", () => {
    const p = newProfile({ model: "m", inPrice: 1, outPrice: 2, maxOutputTokens: 8000 });
    const text = "x".repeat(4000);
    const at = Date.UTC(2026, 0, 1);
    const bare = tokenEstimate(text, p, at, { prompt: BUILT_IN_PROMPT });
    expect(bare.reasoningTokens).toBe(0);
    const thinking = tokenEstimate(text, p, at, {
      prompt: BUILT_IN_PROMPT,
      reasoningPerInputToken: 0.75,
    });
    expect(thinking.inputTokens).toBe(bare.inputTokens);
    expect(thinking.reasoningTokens).toBe(Math.ceil(bare.inputTokens * 0.75));
    expect(thinking.outputTokens).toBe(bare.outputTokens + thinking.reasoningTokens);
    expect(thinking.cost).toBeCloseTo(bare.cost + (thinking.reasoningTokens * 2) / 1e6, 12);
    expect(thinking.reserve).toBe(bare.reserve);
  });

  test("the estimate says what thinking it counts, or that a level set has not been measured", () => {
    expect(reasoningEstimateNote("high", { perInputToken: 0.5, requests: 12 }, 1240)).toBe(
      "incl. ~1,240 thinking tokens a chunk, from the last 12 requests at this level",
    );
    expect(reasoningEstimateNote("high", undefined, 0)).toBe(
      "Thinking isn’t counted yet — no request at this level has reported it.",
    );
    expect(reasoningEstimateNote("off", undefined, 0)).toBeNull();
    expect(reasoningEstimateNote(null, undefined, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The library's default, through the store

/** Keeps what it is sent, and answers with it: `prompt` null when none was ever sent. */
class FakeService implements Partial<EndpointSettingsService> {
  held: EndpointConfig = { endpoints: [], profiles: [], credentials: [], prompt: null };
  puts: EndpointConfig[] = [];
  answer(): EndpointSettings {
    return { ...clone(this.held), prompt: this.held.prompt ?? null } as EndpointSettings;
  }
  async getSettings(): Promise<EndpointSettings> {
    return this.answer();
  }
  async putSettings(body: EndpointConfig): Promise<EndpointSettings> {
    this.puts.push(clone(body));
    // absent keeps what is held, as the server does
    this.held = {
      ...clone(body),
      prompt: body.prompt === undefined ? this.held.prompt : body.prompt,
    };
    return this.answer();
  }
}

let pinia: TestPinia;
let svc: FakeService;
let store: ReturnType<typeof useEndpointsStore>;
const realImmediate = setImmediate;
const drain = () => new Promise<void>((r) => realImmediate(() => r()));
const settle = async () => {
  await drain();
  jest.advanceTimersByTime(WRITE_DELAY_MS);
  await drain();
};

beforeEach(() => {
  jest.useFakeTimers();
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  svc = new FakeService();
  setEndpointSettingsService(svc as unknown as EndpointSettingsService);
  pinia = testPinia();
  store = useEndpointsStore();
  useUiStore().toast = () => "";
});

afterEach(() => {
  store._detach();
  pinia.stop();
  setEndpointSettingsService(null);
  jest.useRealTimers();
});

describe("the library's default prompt with a server answering", () => {
  test("load holds the server's prompt, and none is the built-in one", async () => {
    svc.held.prompt = OWN;
    await store.load();
    expect(store.prompt).toEqual(OWN);
    svc.held.prompt = null;
    await store.load(true);
    expect(store.prompt).toBeNull();
    expect(svc.puts).toEqual([]);
  });

  test("a saved prompt goes out with the configuration, and is not sent back", async () => {
    await store.load();
    expect(store.setLibraryPrompt(OWN)).toBe(true);
    await settle();
    expect(svc.puts).toHaveLength(1);
    expect(svc.puts[0].prompt).toEqual(OWN);
    expect(store.prompt).toEqual(OWN);
    await settle();
    expect(svc.puts).toHaveLength(1);
  });

  test("resetting to the built-in prompt sends null", async () => {
    svc.held.prompt = OWN;
    await store.load();
    expect(store.setLibraryPrompt(clone(BUILT_IN_PROMPT))).toBe(true);
    expect(store.prompt).toBeNull();
    await settle();
    expect(svc.puts.at(-1)!.prompt).toBeNull();
    expect(svc.held.prompt).toBeNull();
  });

  test("a prompt that is not whole is not saved, and nothing is sent", async () => {
    await store.load();
    expect(store.setLibraryPrompt({ system: "Script it.", user: "No excerpt here." })).toBe(false);
    expect(store.prompt).toBeNull();
    await settle();
    expect(svc.puts).toEqual([]);
  });

  test("an endpoint's prompt is saved only when its notes and the mode in use pass, and an empty Default is none", async () => {
    svc.held.profiles = [newProfile({ id: "p1", model: "m" })];
    await store.load();
    const none = { system: "", user: "", notes: "" };
    expect(
      store.setProfilePrompt("p1", { ...none, mode: "replace", system: "x", user: "no tag" }),
    ).toBe(false);
    // notes too long stop a save whatever the mode
    expect(
      store.setProfilePrompt("p1", {
        ...none,
        mode: "default",
        notes: "x".repeat(NOTES_MAX_CHARS + 1),
      }),
    ).toBe(false);
    expect(store.profiles[0].prompt).toBeUndefined();
    // a Default endpoint with notes is kept, not none
    expect(store.setProfilePrompt("p1", { ...none, mode: "default", notes: "Keep apart." })).toBe(
      true,
    );
    await settle();
    expect(svc.puts.at(-1)!.profiles[0].prompt).toEqual({
      ...none,
      mode: "default",
      notes: "Keep apart.",
    });
    expect(
      store.setProfilePrompt("p1", { ...none, mode: "default", system: " ", notes: " " }),
    ).toBe(true);
    expect(store.profiles[0].prompt).toBeNull();
  });

  test("a settings file carries the prompt out and in, and one without it leaves it be", async () => {
    await store.load();
    store.setLibraryPrompt(OWN);
    store.profiles.push(
      newProfile({
        id: "p1",
        model: "m",
        reasoning: "high",
        prompt: { mode: "replace", ...OWN, notes: "Keep apart." },
      }),
    );
    const file = store.exportSettings();
    expect(file.prompt).toEqual(OWN);
    expect(file.profiles[0].reasoning).toBe("high");
    expect(file.profiles[0].prompt).toEqual({ mode: "replace", ...OWN, notes: "Keep apart." });

    store.setLibraryPrompt(null);
    store.profiles.splice(0);
    store.importSettings(clone(file));
    expect(store.prompt).toEqual(OWN);
    expect(store.profiles[0].reasoning).toBe("high");
    expect(store.profiles[0].prompt).toEqual({ mode: "replace", ...OWN, notes: "Keep apart." });

    const older: Partial<SettingsFile> = { ...clone(file), prompt: undefined };
    delete older.prompt;
    store.setLibraryPrompt(null);
    store.importSettings(older);
    expect(store.prompt).toBeNull();
    // a file whose prompt is broken is refused whole
    expect(() =>
      store.importSettings({ ...clone(file), prompt: { system: "", user: "no tag" } }),
    ).toThrow("Invalid default prompt");
  });

  test("an endpoint's Append in a settings file written before notes comes in as its notes", async () => {
    await store.load();
    const file = {
      version: 1,
      exportedAt: "2026-09-01T00:00:00.000Z",
      endpoints: [],
      profiles: [
        {
          ...newProfile({ id: "p1", model: "m" }),
          prompt: { mode: "append", system: "Keep apart.", user: "" },
        },
      ],
      scriptSettings: store.exportSettings().scriptSettings,
    } as unknown as SettingsFile;
    store.importSettings(file);
    expect(store.profiles.find((p) => p.id === "p1")!.prompt).toEqual({
      mode: "default",
      system: "",
      user: "",
      notes: "Keep apart.",
    });
  });
});
