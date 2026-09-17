import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import {
  configErrors,
  expressionPlan,
  expressionParts,
  expressionSupport,
} from "@/lib/expressions";
import type { ExpressionTag } from "@/types";

const laugh: ExpressionTag = {
  id: "laughter",
  label: "Laughter",
  token: "[laughter]",
  kind: "sound",
};
let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let historyStore: ReturnType<typeof useHistoryStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;
let timers: (() => void)[];
let restores: (() => void)[];
let clock: number;
beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  endpointsStore = useEndpointsStore();
  historyStore = useHistoryStore();
  jobsStore = useJobsStore();
  narrationStore = useNarrationStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  jobsStore.jobs = [];
  uiStore.toast = () => "test";
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
  const ep = endpointsStore.endpoints.find((e) => e.id === "local")!;
  ep.enabled = true;
  ep.needsKey = false;
  ep.backoffUntil = 0;
  ep.failRate = 0;
  castStore.characters.cliche.forEach((c) => {
    c.voice = `local/${ep.voices[0].id}`;
  });
  scriptsStore.segments["cliche:1"] = [
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
const endpoint = () => endpointsStore.endpoints.find((e) => e.id === "local")!;
const segment = () => scriptsStore.segmentsOf("cliche", 1)[0];
function configure() {
  const e = endpoint();
  endpointsStore.saveExpressionConfig(e.id, {
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
  narrationStore.addExpression("cliche", 1, 1, laugh, at);
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
  castStore.addTerm("cliche", "laughter", "HA HA");
  const plan = narrationStore.expressionRender("cliche", s);
  expect(plan.text).toBe("Jee Ning [laughter] laughed.\n\nThen he left.");
  expect(s.text).toBe(original);
  expect(plan.tags).toEqual(["[laughter]"]);
  narrationStore.updateExpression("cliche", 1, 1, 1, { at: 3 });
  expect(narrationStore.expressionRender("cliche", s).issues[0].reason).toContain(
    "pronunciation replacement",
  );
});

test("same named expression resolves to the selected model's syntax", () => {
  insert();
  endpoint().expressions!.tags[0].token = "[laugh]";
  expect(narrationStore.expressionRender("cliche", segment()).text).toStartWith("[laugh]");
  endpoint().model = "another-model";
  expect(expressionSupport(endpoint())).toBe("unknown");
  expect(narrationStore.expressionRender("cliche", segment()).issues[0].reason).toContain(
    "not been confirmed",
  );
  configure();
  expect(narrationStore.expressionRender("cliche", segment()).issues).toHaveLength(0);
});

test("unknown and unsupported expressions require review before any audio is changed", () => {
  insert();
  endpoint().expressions!.status = "unsupported";
  const before = JSON.stringify(segment().audio);
  // placing the annotation opened an editing session in the chapter's history; nothing else is due
  const scheduled = timers.length;
  narrationStore.runNarration("cliche", [1]);
  expect(jobsStore.jobs).toHaveLength(0);
  expect(timers).toHaveLength(scheduled);
  expect(JSON.stringify(segment().audio)).toBe(before);
  expect(narrationStore.expressionReview).not.toBeNull();
  narrationStore.continueExpressionReview();
  expect(jobsStore.jobs).toHaveLength(0);
  expect(narrationStore.expressionReview).not.toBeNull();
  narrationStore.omitReviewExpressions();
  narrationStore.continueExpressionReview();
  drain();
  expect(jobsStore.jobs[0].status).toBe("done");
  expect(segment().expressions![0].omitted).toBe(true);
  expect(segment().audio.said).not.toContain("[laughter]");
});

test("an annotation put back where it already was is not an edit of the script", () => {
  insert(8);
  narrationStore.retrySegment("cliche", 1, 1);
  drain();
  expect(segment().audio.status).toBe("done");
  const entries = historyStore.versionsOf("cliche", 1).length;

  // dragging a tag home again: the script still says what the clip was rendered from
  narrationStore.updateExpression("cliche", 1, 1, 1, { at: 8 });
  expect(segment().audio.status).toBe("done");
  expect(historyStore.versionsOf("cliche", 1)).toHaveLength(entries);

  // …and a real move is still an edit, with the clip marked and the session opened
  narrationStore.updateExpression("cliche", 1, 1, 1, { at: 9 });
  expect(segment().audio.status).toBe("stale");
  expect(historyStore.headOf("cliche", 1).origin).toMatchObject({ kind: "edited" });
});

test("omitting the reviewed expressions only touches the lines that had any", () => {
  insert();
  endpoint().expressions!.status = "unsupported";
  // a second chapter in the review with nothing wrong with it: it is not edited, so it neither
  // goes stale nor gains an entry in its own history
  scriptsStore.segments["cliche:2"] = [
    {
      id: 1,
      text: "The mountain said nothing.",
      speaker: "Narrator",
      type: "narration",
      direction: "",
      audio: { status: "done", endpoint: "local", duration: 2, ms: 900 },
    },
  ];
  const clean = JSON.stringify(scriptsStore.segmentsOf("cliche", 2));
  narrationStore.runNarration("cliche", [1]);
  narrationStore.expressionReview!.targets.push({ chId: 2, segId: 1 });

  narrationStore.omitReviewExpressions();
  expect(segment().expressions![0].omitted).toBe(true);
  expect(historyStore.headOf("cliche", 1).origin).toMatchObject({ kind: "edited" });
  expect(JSON.stringify(scriptsStore.segmentsOf("cliche", 2))).toBe(clean);
  expect(historyStore.versionsOf("cliche", 2)).toHaveLength(0);
  expect(historyStore.headOf("cliche", 2).origin.kind).not.toBe("edited");
});

test("dispatch uses the preview, retains expressions in its audit trail and job events", () => {
  insert();
  const planned = narrationStore.expressionRender("cliche", segment()).text;
  narrationStore.retrySegment("cliche", 1, 1);
  drain();
  expect(segment().audio.said).toBe(planned);
  expect(segment().audio.text).toBe(segment().text);
  expect(segment().audio.expressions).toEqual(["[laughter]"]);
  expect(jobsStore.jobs[0].activity!.some((e) => e.detail?.expressions === "[laughter]")).toBe(
    true,
  );
  expect(narrationStore.clipDrift("cliche", segment())).toEqual([]);
});

test("changing an annotation while rendering makes the returned clip stale", () => {
  insert();
  narrationStore.retrySegment("cliche", 1, 1);
  expect(segment().audio.status).toBe("generating");
  narrationStore.updateExpression("cliche", 1, 1, 1, { at: segment().text.length });
  drain();
  expect(segment().audio.status).toBe("stale");
  expect(segment().audio.said).toStartWith("[laughter]");
  expect(narrationStore.clipDrift("cliche", segment())).toContain(
    "expressions: tags, position, or model support changed after this clip",
  );
});

test("model changes stale annotated audio and never dispatch incompatible queued tags", () => {
  insert();
  narrationStore.retrySegment("cliche", 1, 1);
  drain();
  endpoint().model = "new model";
  narrationStore.refreshExpressionAudio();
  expect(segment().audio.status).toBe("stale");
  narrationStore.retrySegment("cliche", 1, 1);
  expect(narrationStore.expressionReview).not.toBeNull();
  expect(timers).toHaveLength(0);
});

test("queued clips recheck capabilities after the run has started", () => {
  insert();
  scriptsStore
    .segmentsOf("cliche", 1)
    .push({ ...structuredClone(JSON.parse(JSON.stringify(segment()))), id: 2 });
  endpoint().concurrency = 1;
  narrationStore.runNarration("cliche", [1]);
  endpoint().model = "new model";
  drain();
  const second = scriptsStore.segmentsOf("cliche", 1)[1];
  expect(second.audio.status).toBe("failed");
  expect(second.audio.error!.message).toContain("Expression needs attention");
  expect(
    jobsStore.jobs[0].activity!.some((e) => e.message === "Segment 2 blocked before dispatch"),
  ).toBe(true);
});

test("split and join preserve annotations at their correct positions without duplicating them", () => {
  const pos = segment().text.indexOf("Then");
  insert(pos);
  const before = segment().text;
  const second = scriptsStore.splitSegment("cliche", 1, 1, pos)!;
  expect(segment().expressions).toHaveLength(0);
  expect(
    scriptsStore.segmentsOf("cliche", 1).find((s) => s.id === second)!.expressions![0].at,
  ).toBe(0);
  scriptsStore.joinSegments("cliche", 1, 1);
  expect(segment().text).toBe(before);
  expect(segment().expressions).toHaveLength(1);
  expect(segment().expressions![0].at).toBe(pos);
});

test("text edits preserve distant anchors but ask for review at an edited anchor", () => {
  insert(segment().text.length);
  const original = segment().text;
  scriptsStore.updateSegment("cliche", 1, 1, { text: "Yesterday " + original });
  expect(segment().expressions![0].at).toBe(segment().text.length);
  narrationStore.updateExpression("cliche", 1, 1, 1, { at: 0 });
  scriptsStore.updateSegment("cliche", 1, 1, { text: "Today " + original });
  expect(segment().expressions![0].needsReview).toBe(true);
  expect(narrationStore.expressionRender("cliche", segment()).issues).toHaveLength(1);
});

test("request chunking never splits an expression, including tags with spaces", () => {
  insert(8);
  endpoint().expressions!.tags[0].token = "[soft laugh]";
  const plan = narrationStore.expressionRender("cliche", segment());
  for (const maxChars of [12, 13, 15, 20]) {
    const parts = expressionParts(plan, { maxChars, splitAt: "word" });
    expect(parts.map((p) => p.text).join("")).toBe(plan.text);
    expect(parts.every((p) => p.text.length <= maxChars)).toBe(true);
    expect(parts.filter((p) => p.text.includes("[soft laugh]"))).toHaveLength(1);
    expect(parts.filter((p) => /\[|\]/.test(p.text))).toHaveLength(1);
  }
  endpoint().maxChars = 3;
  expect(narrationStore.expressionRender("cliche", segment()).issues[0].reason).toContain(
    "character limit",
  );
});

test("retake snapshots retain the expressions that were actually rendered", () => {
  insert();
  narrationStore.retrySegment("cliche", 1, 1);
  drain();
  narrationStore.retakeSegment("cliche", 1, 1);
  drain();
  narrationStore.acceptTake("cliche", 1, 1);
  expect(segment().audio.takes![0].expressions).toEqual(["[laughter]"]);
  expect(segment().audio.takes![0].expressionSignature).toBe(segment().audio.expressionSignature);
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

test("a deleted tag does not fall back to sending the old syntax", () => {
  insert();
  endpoint().expressions!.tags = [];
  const plan = narrationStore.expressionRender("cliche", segment());
  expect(plan.issues).toHaveLength(1);
  expect(plan.tags).toHaveLength(0);
});
