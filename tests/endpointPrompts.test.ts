// The scripting prompt and reasoning level on the endpoints side: what an endpoint may be set to,
// what its estimate counts the prompt at, and how the library's default travels with the rest of
// the configuration — kept as null while it is the built-in prompt, saved only when it is a whole
// prompt, and carried by a settings file.
//
// The service is a fake that keeps the document in memory, as in `endpointsBackend.test.ts`; how
// the server stores and checks the prompt is `tests/server/`'s.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { credentials, type Credential } from "@/lib/credentials";
import { BUILT_IN_PROMPT, promptOverhead } from "@/lib/prompt";
import { newProfile, profileErrors, tokenEstimate } from "@/lib/scripting";
import { clone } from "@/lib/utils";
import {
  setEndpointSettingsService,
  type EndpointConfig,
  type EndpointSettings,
  type EndpointSettingsService,
} from "@/services/endpointSettings";
import { useEndpointsStore, WRITE_DELAY_MS } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import type { PromptTemplate, SettingsFile } from "@/types";
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
      prompt: { mode: "append", system: "Keep paragraphs apart.", user: "" },
    });
    expect(q.reasoning).toBe("low");
    expect(q.prompt).toEqual({ mode: "append", system: "Keep paragraphs apart.", user: "" });
    expect(profileErrors(q)).toEqual([]);
  });

  test("only the mode in use is checked", () => {
    const p = newProfile({ model: "m" });
    // an addition must not bring a second excerpt…
    p.prompt = { mode: "append", system: "", user: "Again: {{excerpt}}" };
    expect(profileErrors(p)).toEqual([
      "Prompt: An addition must not include {{excerpt}}: the prompt it adds to already has it.",
    ]);
    // …a replacement must have one…
    p.prompt = { mode: "replace", system: "Script it.", user: "Chapter {{chapter.title}}" };
    expect(profileErrors(p)).toEqual([
      "Prompt: The user message must include {{excerpt}}, the text to script.",
    ]);
    // …and a Default endpoint's kept text is not sent, so it is not held against it
    p.prompt = { mode: "default", system: "{{nonsense}}", user: "" };
    expect(profileErrors(p)).toEqual([]);
    p.prompt = { mode: "replace", ...OWN };
    expect(profileErrors(p)).toEqual([]);
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
    const withPrompt = tokenEstimate(text, p, at, long);
    expect(withPrompt.inputTokens).toBe(1600 + Math.ceil(promptOverhead(long) / 4));
    // eight thousand characters more than the built-in prompt's system message is about 2,000
    // tokens more, less what the flat 500 undercounted the built-in one by
    expect(withPrompt.inputTokens).toBeGreaterThan(bare.inputTokens + 1500);
    // the output side does not depend on the prompt
    expect(withPrompt.outputTokens).toBe(bare.outputTokens);
    expect(withPrompt.inputCost).toBeCloseTo((withPrompt.inputTokens * 1) / 1e6, 12);
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
let registry: Credential[];
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
  registry = clone([...credentials]);
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
  credentials.splice(0, credentials.length, ...registry);
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

  test("an endpoint's prompt is saved only for the mode in use, and an empty Default is none", async () => {
    svc.held.profiles = [newProfile({ id: "p1", model: "m" })];
    await store.load();
    expect(store.setProfilePrompt("p1", { mode: "replace", system: "x", user: "no tag" })).toBe(
      false,
    );
    expect(store.profiles[0].prompt).toBeUndefined();
    expect(store.setProfilePrompt("p1", { mode: "append", system: "Keep apart.", user: "" })).toBe(
      true,
    );
    await settle();
    expect(svc.puts.at(-1)!.profiles[0].prompt).toEqual({
      mode: "append",
      system: "Keep apart.",
      user: "",
    });
    expect(store.setProfilePrompt("p1", { mode: "default", system: " ", user: "" })).toBe(true);
    expect(store.profiles[0].prompt).toBeNull();
  });

  test("a settings file carries the prompt out and in, and one without it leaves it be", async () => {
    await store.load();
    store.setLibraryPrompt(OWN);
    store.profiles.push(
      newProfile({ id: "p1", model: "m", reasoning: "high", prompt: { mode: "replace", ...OWN } }),
    );
    const file = store.exportSettings();
    expect(file.prompt).toEqual(OWN);
    expect(file.profiles[0].reasoning).toBe("high");
    expect(file.profiles[0].prompt).toEqual({ mode: "replace", ...OWN });

    store.setLibraryPrompt(null);
    store.profiles.splice(0);
    store.importSettings(clone(file));
    expect(store.prompt).toEqual(OWN);
    expect(store.profiles[0].reasoning).toBe("high");
    expect(store.profiles[0].prompt).toEqual({ mode: "replace", ...OWN });

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
});
