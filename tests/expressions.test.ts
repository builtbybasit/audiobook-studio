import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useApp } from "../src/stores/app";
import {
  configErrors,
  expressionPlan,
  expressionParts,
  expressionSupport,
} from "../src/lib/expressions";
import type { ExpressionTag } from "../src/types";

const laugh: ExpressionTag = {
  id: "laughter",
  label: "Laughter",
  token: "[laughter]",
  kind: "sound",
};
let app: ReturnType<typeof useApp>;
let timers: (() => void)[];
let restores: (() => void)[];
let clock: number;
beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  app = useApp();
  app.jobs = [];
  app.toast = () => "test";
  timers = [];
  clock = 1000;
  restores = [
    spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      timers.push(fn);
      return timers.length;
    }) as unknown as typeof setTimeout),
    spyOn(Date, "now").mockImplementation(() => clock),
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
  const ep = app.endpoints.find((e) => e.id === "local")!;
  ep.enabled = true;
  ep.needsKey = false;
  ep.backoffUntil = 0;
  ep.failRate = 0;
  app.characters.cliche.forEach((c) => {
    c.voice = `local/${ep.voices[0].id}`;
  });
  app.segments["cliche:1"] = [
    {
      id: 1,
      text: "Ji Ning laughed.\n\nThen he left.",
      speaker: "Narrator",
      type: "narration",
      direction: "",
      audio: { status: "none", endpoint: null, duration: 0, ms: 0 },
    },
  ];
});
afterEach(() => restores.forEach((r) => r()));
const endpoint = () => app.endpoints.find((e) => e.id === "local")!;
const segment = () => app.segmentsOf("cliche", 1)[0];
function configure() {
  const e = endpoint();
  app.saveExpressionConfig(e.id, {
    status: "supported",
    model: e.model,
    baseUrl: e.baseUrl,
    tags: [laugh],
  });
}
function drain() {
  for (let guard = 0; timers.length && guard < 300; guard++) {
    clock += 1000;
    const due = timers;
    timers = [];
    due.forEach((fn) => fn());
  }
  expect(timers).toHaveLength(0);
}
function insert(at = 0) {
  configure();
  app.addExpression("cliche", 1, 1, laugh, at);
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
  app.addTerm("cliche", "laughter", "HA HA");
  const plan = app.expressionRender("cliche", s);
  expect(plan.text).toBe("Jee Ning [laughter] laughed.\n\nThen he left.");
  expect(s.text).toBe(original);
  expect(plan.tags).toEqual(["[laughter]"]);
  app.updateExpression("cliche", 1, 1, 1, { at: 3 });
  expect(app.expressionRender("cliche", s).issues[0].reason).toContain("pronunciation replacement");
});

test("same named expression resolves to the selected model's syntax", () => {
  insert();
  endpoint().expressions!.tags[0].token = "[laugh]";
  expect(app.expressionRender("cliche", segment()).text).toStartWith("[laugh]");
  endpoint().model = "another-model";
  expect(expressionSupport(endpoint())).toBe("unknown");
  expect(app.expressionRender("cliche", segment()).issues[0].reason).toContain(
    "not been confirmed",
  );
  configure();
  expect(app.expressionRender("cliche", segment()).issues).toHaveLength(0);
});

test("unknown and unsupported expressions require review before any audio is changed", () => {
  insert();
  endpoint().expressions!.status = "unsupported";
  const before = JSON.stringify(segment().audio);
  app.runNarration("cliche", [1]);
  expect(app.jobs).toHaveLength(0);
  expect(timers).toHaveLength(0);
  expect(JSON.stringify(segment().audio)).toBe(before);
  expect(app.expressionReview).not.toBeNull();
  app.continueExpressionReview();
  expect(app.jobs).toHaveLength(0);
  expect(app.expressionReview).not.toBeNull();
  app.omitReviewExpressions();
  app.continueExpressionReview();
  drain();
  expect(app.jobs[0].status).toBe("done");
  expect(segment().expressions![0].omitted).toBe(true);
  expect(segment().audio.said).not.toContain("[laughter]");
});

test("dispatch uses the preview, retains expressions in its audit trail and job events", () => {
  insert();
  const planned = app.expressionRender("cliche", segment()).text;
  app.retrySegment("cliche", 1, 1);
  drain();
  expect(segment().audio.said).toBe(planned);
  expect(segment().audio.text).toBe(segment().text);
  expect(segment().audio.expressions).toEqual(["[laughter]"]);
  expect(app.jobs[0].activity!.some((e) => e.detail?.expressions === "[laughter]")).toBe(true);
  expect(app.clipDrift("cliche", segment())).toEqual([]);
});

test("changing an annotation while rendering makes the returned clip stale", () => {
  insert();
  app.retrySegment("cliche", 1, 1);
  expect(segment().audio.status).toBe("generating");
  app.updateExpression("cliche", 1, 1, 1, { at: segment().text.length });
  drain();
  expect(segment().audio.status).toBe("stale");
  expect(segment().audio.said).toStartWith("[laughter]");
  expect(app.clipDrift("cliche", segment())).toContain(
    "expressions: tags, position, or model support changed after this clip",
  );
});

test("model changes stale annotated audio and never dispatch incompatible queued tags", () => {
  insert();
  app.retrySegment("cliche", 1, 1);
  drain();
  endpoint().model = "new model";
  app.refreshExpressionAudio();
  expect(segment().audio.status).toBe("stale");
  app.retrySegment("cliche", 1, 1);
  expect(app.expressionReview).not.toBeNull();
  expect(timers).toHaveLength(0);
});

test("queued clips recheck capabilities after the run has started", () => {
  insert();
  app
    .segmentsOf("cliche", 1)
    .push({ ...structuredClone(JSON.parse(JSON.stringify(segment()))), id: 2 });
  endpoint().concurrency = 1;
  app.runNarration("cliche", [1]);
  endpoint().model = "new model";
  drain();
  const second = app.segmentsOf("cliche", 1)[1];
  expect(second.audio.status).toBe("failed");
  expect(second.audio.error!.message).toContain("Expression needs attention");
  expect(app.jobs[0].activity!.some((e) => e.message === "Segment 2 blocked before dispatch")).toBe(
    true,
  );
});

test("split and join preserve annotations at their correct positions without duplicating them", () => {
  const pos = segment().text.indexOf("Then");
  insert(pos);
  const before = segment().text;
  const second = app.splitSegment("cliche", 1, 1, pos)!;
  expect(segment().expressions).toHaveLength(0);
  expect(app.segmentsOf("cliche", 1).find((s) => s.id === second)!.expressions![0].at).toBe(0);
  app.joinSegments("cliche", 1, 1);
  expect(segment().text).toBe(before);
  expect(segment().expressions).toHaveLength(1);
  expect(segment().expressions![0].at).toBe(pos);
});

test("text edits preserve distant anchors but ask for review at an edited anchor", () => {
  insert(segment().text.length);
  const original = segment().text;
  app.updateSegment("cliche", 1, 1, { text: "Yesterday " + original });
  expect(segment().expressions![0].at).toBe(segment().text.length);
  app.updateExpression("cliche", 1, 1, 1, { at: 0 });
  app.updateSegment("cliche", 1, 1, { text: "Today " + original });
  expect(segment().expressions![0].needsReview).toBe(true);
  expect(app.expressionRender("cliche", segment()).issues).toHaveLength(1);
});

test("request chunking never splits an expression, including tags with spaces", () => {
  insert(8);
  endpoint().expressions!.tags[0].token = "[soft laugh]";
  const plan = app.expressionRender("cliche", segment());
  for (const maxChars of [12, 13, 15, 20]) {
    const parts = expressionParts(plan, { maxChars, splitAt: "word" });
    expect(parts.map((p) => p.text).join("")).toBe(plan.text);
    expect(parts.every((p) => p.text.length <= maxChars)).toBe(true);
    expect(parts.filter((p) => p.text.includes("[soft laugh]"))).toHaveLength(1);
    expect(parts.filter((p) => /\[|\]/.test(p.text))).toHaveLength(1);
  }
  endpoint().maxChars = 3;
  expect(app.expressionRender("cliche", segment()).issues[0].reason).toContain("character limit");
});

test("retake snapshots retain the expressions that were actually rendered", () => {
  insert();
  app.retrySegment("cliche", 1, 1);
  drain();
  app.retakeSegment("cliche", 1, 1);
  drain();
  app.acceptTake("cliche", 1, 1);
  expect(segment().audio.takes![0].expressions).toEqual(["[laughter]"]);
  expect(segment().audio.takes![0].expressionSignature).toBe(segment().audio.expressionSignature);
});

test("invalid tag definitions cannot be saved or imported", () => {
  configure();
  const config = JSON.parse(JSON.stringify(endpoint().expressions!));
  config.tags[0].token = "[nested [tag]]";
  expect(configErrors(config).length).toBeGreaterThan(0);
  expect(app.saveExpressionConfig(endpoint().id, config)).toBe(false);
  const settings = JSON.parse(JSON.stringify(app.exportSettings()));
  settings.endpoints.find((e: { id: string }) => e.id === endpoint().id).expressions = config;
  expect(() => app.importSettings(settings)).toThrow("Invalid expression support");
});

test("a deleted tag does not fall back to sending the old syntax", () => {
  insert();
  endpoint().expressions!.tags = [];
  const plan = app.expressionRender("cliche", segment());
  expect(plan.issues).toHaveLength(1);
  expect(plan.tags).toHaveLength(0);
});
