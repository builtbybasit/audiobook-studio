// Expression tags as the page places them: anchored in a line's text, spelled the way the endpoint
// the line's voice is on says, and kept out of every edit of the prose around them. The stores here
// answer to a seeded demo library, so an edit is written as the page writes it; the speech endpoint
// the tags are configured on is one the test adds, with a model that takes bracketed tags.
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { test, expect, beforeEach, afterEach } from "bun:test";

import {
  configErrors,
  expressionPlan,
  expressionParts,
  expressionSupport,
} from "@/lib/expressions";
import { libraryService } from "@/services/library";
import type { Endpoint, ExpressionTag } from "@/types";
import { demoServer } from "./support/demoServer";
import { testPinia, type TestPinia } from "./support/pinia";

const BOOK = "cliche";
const laugh: ExpressionTag = {
  id: "laughter",
  label: "Laughter",
  token: "[laughter]",
  kind: "sound",
};
/** A self-hosted speech endpoint, whose model takes whatever tags it is told it does. */
const studio = (): Endpoint => ({
  id: "studio",
  name: "Studio Kokoro",
  baseUrl: "http://127.0.0.1:8880/v1",
  model: "kokoro",
  concurrency: 2,
  enabled: true,
  latency: 1000,
  failRate: 0,
  price: 0,
  billing: { unit: "chars", rate: 0 },
  needsKey: false,
  maxChars: 500,
  splitAt: "sentence",
  voices: [{ id: "af_heart", label: "Heart", gender: "f" }],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
});
let pinia: TestPinia;
let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let historyStore: ReturnType<typeof useHistoryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
beforeEach(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  await demoServer();
  pinia = testPinia();
  castStore = useCastStore();
  endpointsStore = useEndpointsStore();
  historyStore = useHistoryStore();
  narrationStore = useNarrationStore();
  scriptsStore = useScriptsStore();
  const libraryStore = useLibraryStore();
  useUiStore().toast = () => "test";
  const svc = libraryService();
  await Promise.all([libraryStore.load(true), endpointsStore.load()]);
  // the endpoint is the test's own: nothing about it needs to reach the server
  endpointsStore._detach();
  endpointsStore.endpoints.push(studio());
  await libraryStore.loadBook(BOOK);
  castStore._install(BOOK, await svc.cast(BOOK));
  for (const c of castStore.characters[BOOK]) c.voice = "studio/af_heart";
  // chapter 1 is one line, at the revision the server holds, so the next edit of it is accepted
  const { revision } = await svc.chapterScript(BOOK, 1);
  scriptsStore._install(BOOK, 1, {
    revision,
    segments: [
      {
        id: 1,
        text: "Ji Ning laughed.\n\nThen he left.",
        speaker: "Narrator",
        type: "narration",
        direction: "",
        audio: { status: "none", endpoint: null, duration: 0, ms: 0 },
      },
    ],
  });
  historyStore._install(BOOK, 1, await svc.chapterHistory(BOOK, 1));
});
afterEach(async () => {
  await scriptsStore._settled(BOOK, 1);
  pinia.stop();
});
const endpoint = () => endpointsStore.endpoints.find((e) => e.id === "studio")!;
const segment = () => scriptsStore.segmentsOf(BOOK, 1)[0];
function configure() {
  const e = endpoint();
  endpointsStore.saveExpressionConfig(e.id, {
    status: "supported",
    model: e.model,
    baseUrl: e.baseUrl,
    tags: [laugh],
  });
}
function insert(at = 0) {
  configure();
  narrationStore.addExpression(BOOK, 1, 1, laugh, at);
}

test("ordinary bracketed prose is unchanged, even on an unconfigured model", () => {
  const s = { text: "[laughter] is printed in this book. [Footnote 2]" };
  const plan = expressionPlan(s, endpoint());
  expect(plan.text).toBe(s.text);
  expect(plan.issues).toHaveLength(0);
  expect(plan.tags).toHaveLength(0);
});

test("pronunciation runs on prose, expression tags stay exact and anchors follow replacements", () => {
  insert(8);
  const s = segment();
  const original = s.text;
  castStore.addTerm(BOOK, "laughter", "HA HA");
  const plan = narrationStore.expressionRender(BOOK, s);
  expect(plan.text).toBe("Jee Ning [laughter] laughed.\n\nThen he left.");
  expect(s.text).toBe(original);
  expect(plan.tags).toEqual(["[laughter]"]);
  narrationStore.updateExpression(BOOK, 1, 1, 1, { at: 3 });
  expect(narrationStore.expressionRender(BOOK, s).issues[0].reason).toContain(
    "pronunciation replacement",
  );
});

test("same named expression resolves to the selected model's syntax", () => {
  insert();
  endpoint().expressions!.tags[0].token = "[laugh]";
  expect(narrationStore.expressionRender(BOOK, segment()).text).toStartWith("[laugh]");
  endpoint().model = "another-model";
  expect(expressionSupport(endpoint())).toBe("unknown");
  expect(narrationStore.expressionRender(BOOK, segment()).issues[0].reason).toContain(
    "not been confirmed",
  );
  configure();
  expect(narrationStore.expressionRender(BOOK, segment()).issues).toHaveLength(0);
});

test("an annotation put back where it already was is not an edit of the script", async () => {
  insert(8);
  await scriptsStore._settled(BOOK, 1);
  // the line as it stands has been rendered
  segment().audio.status = "done";
  const entries = historyStore.versionsOf(BOOK, 1).length;

  // dragging a tag home again: the script still says what the clip was rendered from
  narrationStore.updateExpression(BOOK, 1, 1, 1, { at: 8 });
  expect(segment().audio.status).toBe("done");
  await scriptsStore._settled(BOOK, 1);
  expect(historyStore.versionsOf(BOOK, 1)).toHaveLength(entries);

  // …and a real move is still an edit, with the clip marked and the edit recorded
  narrationStore.updateExpression(BOOK, 1, 1, 1, { at: 9 });
  expect(segment().audio.status).toBe("stale");
  await scriptsStore._settled(BOOK, 1);
  expect(historyStore.headOf(BOOK, 1).origin).toMatchObject({ kind: "edited" });
});

test("split and join preserve annotations at their correct positions without duplicating them", () => {
  const pos = segment().text.indexOf("Then");
  insert(pos);
  const before = segment().text;
  const second = scriptsStore.splitSegment(BOOK, 1, 1, pos)!;
  expect(segment().expressions).toHaveLength(0);
  expect(scriptsStore.segmentsOf(BOOK, 1).find((s) => s.id === second)!.expressions![0].at).toBe(0);
  scriptsStore.joinSegments(BOOK, 1, 1);
  expect(segment().text).toBe(before);
  expect(segment().expressions).toHaveLength(1);
  expect(segment().expressions![0].at).toBe(pos);
});

test("text edits preserve distant anchors but ask for review at an edited anchor", () => {
  insert(segment().text.length);
  const original = segment().text;
  scriptsStore.updateSegment(BOOK, 1, 1, { text: "Yesterday " + original });
  expect(segment().expressions![0].at).toBe(segment().text.length);
  narrationStore.updateExpression(BOOK, 1, 1, 1, { at: 0 });
  scriptsStore.updateSegment(BOOK, 1, 1, { text: "Today " + original });
  expect(segment().expressions![0].needsReview).toBe(true);
  expect(narrationStore.expressionRender(BOOK, segment()).issues).toHaveLength(1);
});

test("request chunking never splits an expression, including tags with spaces", () => {
  insert(8);
  endpoint().expressions!.tags[0].token = "[soft laugh]";
  const plan = narrationStore.expressionRender(BOOK, segment());
  for (const maxChars of [12, 13, 15, 20]) {
    const parts = expressionParts(plan, { maxChars, splitAt: "word" });
    expect(parts.map((p) => p.text).join("")).toBe(plan.text);
    expect(parts.every((p) => p.text.length <= maxChars)).toBe(true);
    expect(parts.filter((p) => p.text.includes("[soft laugh]"))).toHaveLength(1);
    expect(parts.filter((p) => /\[|\]/.test(p.text))).toHaveLength(1);
  }
  endpoint().maxChars = 3;
  expect(narrationStore.expressionRender(BOOK, segment()).issues[0].reason).toContain(
    "character limit",
  );
});

test("invalid tag definitions cannot be saved or imported", () => {
  configure();
  const config = JSON.parse(JSON.stringify(endpoint().expressions!));
  config.tags[0].token = "[nested [tag]]";
  expect(configErrors(config).length).toBeGreaterThan(0);
  expect(endpointsStore.saveExpressionConfig(endpoint().id, config)).toBe(false);
  const settings = JSON.parse(JSON.stringify(endpointsStore.exportSettings()));
  settings.endpoints.find((e: { id: string }) => e.id === endpoint().id).expressions = config;
  expect(() => endpointsStore.importSettings(settings)).toThrow("Invalid expression support");
});

test("tags are checked against the model they are saved for, not the one the draft was opened on", () => {
  // drafted while the endpoint pointed at a server that takes brackets, saved after it was moved
  // to OpenAI, which documents no tags: the tags would be refused on every line, so the save is
  const e = endpoint();
  const draft = { status: "supported" as const, model: e.model, baseUrl: e.baseUrl, tags: [laugh] };
  e.baseUrl = "https://api.openai.com/v1";
  e.model = "gpt-4o-mini-tts";
  expect(endpointsStore.saveExpressionConfig(e.id, draft)).toBe(false);
  expect(e.expressions).toBeUndefined();
});

test("a deleted tag does not fall back to sending the old syntax", () => {
  insert();
  endpoint().expressions!.tags = [];
  const plan = narrationStore.expressionRender(BOOK, segment());
  expect(plan.issues).toHaveLength(1);
  expect(plan.tags).toHaveLength(0);
});
