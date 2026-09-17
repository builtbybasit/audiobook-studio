import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore, SESSION_IDLE_MS } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// Chapter script history: the versions a chapter's script has been through, and restoring one.
//
// The four properties the feature rests on are the ones tested hardest here. A version is an
// *independent* copy, so nothing that happens later can reach into it. An entry is only made when
// something actually changed, and a run that produced nothing never replaces a good script. A
// comparison says what really moved between two scripts. And a restore keeps the audio that still
// belongs to the restored lines, marks what no longer matches, and can be undone whole.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { compareScripts, scriptSignature, wordDiff } from "@/lib/scriptHistory";
import { keyring } from "@/lib/keyring";
import { newProfile } from "@/lib/scripting";
import { SEEDED_KEYS } from "@/mock";
import type { Segment } from "@/types";

let timers = new Map<number, { fn: () => void; repeat: boolean }>();
let clock = 1_000_000;
let restore: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let demoStore: ReturnType<typeof useDemoStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let historyStore: ReturnType<typeof useHistoryStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;
/** every undo a toast was given, in order */
let undos: (() => void)[] = [];
const undoLast = () => undos.at(-1)!();

function tick() {
  for (const [id, t] of Array.from(timers)) {
    if (!timers.has(id)) continue;
    if (!t.repeat) timers.delete(id);
    t.fn();
  }
}
function drain(max = 300) {
  for (let i = 0; i < max && timers.size; i++) {
    clock += 1000;
    tick();
  }
}

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  demoStore = useDemoStore();
  endpointsStore = useEndpointsStore();
  historyStore = useHistoryStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  // the real toast needs a DOM; this stub also keeps the last undo it was offered, which is how the
  // tests below take back a batch or a restore exactly as the toast's Undo button would
  undos = [];
  uiStore.toast = (_msg, opts = {}) => {
    if (opts.undo) undos.push(opts.undo);
    return "test";
  };
  jobsStore.jobs = [];
  // the demo's own credentials, as `main.ts` sets them up: without them every clip fails for want
  // of a key and there is no audio to carry across a restore
  for (const [id, value] of SEEDED_KEYS) keyring.set(id, value);
  timers = new Map();
  clock = 1_000_000;
  let seq = 0;
  const add = (fn: () => void, repeat: boolean) => {
    timers.set(++seq, { fn, repeat });
    return seq;
  };
  restore = [
    spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) =>
      add(fn, true)) as typeof setInterval),
    spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) =>
      add(fn, false)) as typeof setTimeout),
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      timers.delete(id);
    }) as typeof clearInterval),
    spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout),
    spyOn(Date, "now").mockImplementation(() => clock),
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((f) => f()));

const segments = (chId = 1) => scriptsStore.segmentsOf("cliche", chId);
const versions = (chId = 1) => historyStore.versionsOf("cliche", chId);
const head = (chId = 1) => historyStore.headOf("cliche", chId);
/** Let the idle window pass, so the next edit is a session of its own. */
function quiet() {
  clock += SESSION_IDLE_MS + 1;
  tick();
}

describe("what makes an entry", () => {
  test("a run of edits is one entry, and the next run after a pause is another", () => {
    const first = segments()[0];
    const wasSpeaker = first.speaker;
    scriptsStore.updateSegment("cliche", 1, first.id, { direction: "wary" });
    scriptsStore.setSpeaker("cliche", 1, segments()[1].id, "Elder Mo");
    expect(versions()).toHaveLength(1);
    expect(head().origin).toEqual({ kind: "edited", edits: 2 });
    expect(head().open).toBe(true);
    // the entry holds the script as it was *before* the session, not after it
    expect(versions()[0].segments[0].direction).not.toBe("wary");
    expect(versions()[0].segments[0].speaker).toBe(wasSpeaker);

    quiet();
    expect(head().open).toBe(false);
    scriptsStore.updateSegment("cliche", 1, first.id, { direction: "flat" });
    expect(versions()).toHaveLength(2);
    expect(head().origin).toEqual({ kind: "edited", edits: 1 });
    // …and the second entry holds what the first session produced
    expect(versions()[0].segments[0].direction).toBe("wary");
  });

  test("an edit that changes nothing leaves no entry", () => {
    const s = segments()[0];
    scriptsStore.setSpeaker("cliche", 1, s.id, s.speaker);
    scriptsStore.updateSegment("cliche", 1, s.id, { direction: s.direction });
    expect(versions()).toHaveLength(0);
  });

  test("undoing an edit takes the entry it opened off with it", () => {
    const before = scriptSignature(segments());
    const s = segments()[0];
    scriptsStore.splitSegment("cliche", 1, s.id, s.text.indexOf(" ", 10) + 1);
    expect(versions()).toHaveLength(1);
    expect(head().origin).toEqual({ kind: "edited", edits: 1 });

    undoLast();
    // the script is back, so the list must not claim a manual edit — nor keep a copy of a script
    // that is the one we are looking at
    expect(scriptSignature(segments())).toBe(before);
    expect(versions()).toHaveLength(0);
    expect(head().origin.kind).toBe("scripted");
    expect(head().open).toBeFalsy();
  });

  test("undoing one edit of a session leaves the rest of the session standing", () => {
    const s = segments()[0];
    scriptsStore.splitSegment("cliche", 1, s.id, s.text.indexOf(" ", 10) + 1);
    const after = JSON.stringify(segments());
    scriptsStore.deleteSegment("cliche", 1, segments()[3].id);
    expect(head().origin).toEqual({ kind: "edited", edits: 2 });

    undoLast();
    expect(JSON.stringify(segments())).toBe(after);
    expect(head().origin).toEqual({ kind: "edited", edits: 1 });
    expect(head().open).toBe(true);
    expect(versions()).toHaveLength(1);
    // the session is still the one the first edit opened, and still closes on its own
    quiet();
    expect(head().open).toBe(false);
  });

  test("every kind of script edit joins the session; a clip finishing does not", () => {
    const s = segments()[0];
    scriptsStore.splitSegment("cliche", 1, s.id, s.text.indexOf(" ", 10) + 1);
    castStore.setPause("cliche", 1, s.id, 1.5);
    narrationStore.flagSegment("cliche", 1, s.id, "delivery", "rushed");
    segments()[0].audio.status = "done";
    expect(head().origin).toEqual({ kind: "edited", edits: 2 });
    expect(versions()).toHaveLength(1);
  });
});

describe("snapshot independence", () => {
  test("nothing that happens later can reach into a saved version", () => {
    historyStore.saveCheckpoint("cliche", 1, "Dialogue reviewed");
    const saved = versions()[0];
    const before = JSON.stringify(saved.segments);
    const first = segments()[0];
    scriptsStore.updateSegment("cliche", 1, first.id, { text: "Something else entirely." });
    scriptsStore.setSpeaker("cliche", 1, segments()[1].id, "Xiao Lan");
    scriptsStore.deleteSegment("cliche", 1, segments()[2].id);
    narrationStore.runNarration("cliche", [1]);
    drain();
    expect(JSON.stringify(versions().find((v) => v.id === saved.id)!.segments)).toBe(before);
  });

  test("a version keeps the script and not the audio", () => {
    narrationStore.runNarration("cliche", [1]);
    drain();
    expect(segments().some((s) => s.audio.duration > 0)).toBe(true);
    historyStore.saveCheckpoint("cliche", 1, "Narrated");
    const saved = versions()[0].segments;
    expect(saved.every((s) => s.audio.status === "none" && s.audio.duration === 0)).toBe(true);
    expect(scriptSignature(saved)).toBe(scriptSignature(segments()));
  });
});

describe("checkpoints", () => {
  test("a checkpoint names the script without changing it, and says how it got there", () => {
    scriptsStore.setSpeaker("cliche", 1, segments()[1].id, "Elder Mo");
    const before = JSON.stringify(segments());
    const saved = historyStore.saveCheckpoint("cliche", 1, "  Dialogue reviewed  ");
    expect(saved!.origin).toEqual({
      kind: "checkpoint",
      name: "Dialogue reviewed",
      was: { kind: "edited", edits: 1 },
    });
    expect(JSON.stringify(segments())).toBe(before);
    expect(historyStore.comparisonOf("cliche", 1, saved!.id)!.identical).toBe(true);
    expect(historyStore.saveCheckpoint("cliche", 1, "   ")).toBeNull();
  });
});

describe("re-scripting", () => {
  function profile() {
    const p = newProfile({
      id: "test",
      name: "Test endpoint",
      model: "test-model",
      needsKey: false,
      concurrency: 2,
      maxChars: 4000,
      inPrice: 0,
      outPrice: 0,
      maxOutputTokens: 4000,
    });
    endpointsStore.profiles = [p];
    scriptingStore.scriptSettings.profile = p.id;
    return p;
  }

  test("a re-script keeps the script it replaced, named for what produced it", () => {
    profile();
    const before = scriptSignature(segments());
    scriptingStore.runScripting("cliche", [1]);
    drain();
    expect(libraryStore.chapter("cliche", 1)!.scripting).not.toBe("failed");
    expect(versions()).toHaveLength(1);
    expect(scriptSignature(versions()[0].segments)).toBe(before);
    expect(head().origin).toEqual({
      kind: "scripted",
      profile: "Test endpoint",
      model: "test-model",
      again: true,
    });
  });

  test("a script that differs only in its spacing is still one worth keeping", () => {
    const p = profile();
    const before = scriptSignature(segments());
    // the same words, laid out differently: the prose changed, so what it replaces is worth keeping
    const respaced = segments().map((s) => ({ ...s, text: s.text.replace(/\. /g, ".\n\n") }));
    expect(scriptSignature(respaced)).not.toBe(before);
    historyStore.noteScripted("cliche", 1, p, respaced);
    scriptsStore.segments["cliche:1"] = respaced;
    expect(versions()).toHaveLength(1);
    expect(scriptSignature(versions()[0].segments)).toBe(before);

    // …while a run that came back with the very same script adds nothing
    quiet();
    historyStore.noteScripted("cliche", 1, p, segments());
    expect(versions()).toHaveLength(1);
  });

  test("a run that kept nothing does not replace a good script in the history", () => {
    profile();
    const before = scriptSignature(segments());
    // the simulated verifier fails this run outright
    spyOn(Math, "random").mockReturnValue(0.01);
    scriptingStore.runScripting("cliche", [1]);
    drain();
    expect(libraryStore.chapter("cliche", 1)!.scripting).toBe("failed");
    expect(versions()).toHaveLength(0);
    expect(scriptSignature(segments())).toBe(before);
  });

  test("a cancelled run leaves the script and the history alone", () => {
    profile();
    const before = scriptSignature(segments());
    scriptingStore.runScripting("cliche", [1]);
    tick();
    jobsStore.cancelJob(jobsStore.jobs[0].id);
    drain();
    expect(versions()).toHaveLength(0);
    expect(scriptSignature(segments())).toBe(before);
  });

  test("scripting a chapter for the first time has nothing to preserve", () => {
    profile();
    delete scriptsStore.segments["cliche:9"];
    const c = libraryStore.chapter("cliche", 9)!;
    c.scripting = "none";
    scriptingStore.runScripting("cliche", [9]);
    drain();
    expect(segments(9).length).toBeGreaterThan(0);
    expect(versions(9)).toHaveLength(0);
    expect(head(9).origin).toMatchObject({ kind: "scripted", again: false });
  });
});

describe("bulk corrections", () => {
  const targets = (chId: number, n: number) =>
    scriptsStore
      .segmentsOf("cliche", chId)
      .slice(0, n)
      .map((s) => ({ chId, segId: s.id }));

  test("one entry per chapter the batch changes, and undo takes it back off", () => {
    const batch = [...targets(1, 4), ...targets(2, 3)];
    const result = scriptsStore.applyBulk("cliche", batch, {
      kind: "speaker",
      speaker: "Elder Mo",
    });
    expect(result.changed).toBeGreaterThan(0);
    // the entry holds the script the batch replaced; the batch itself is what the current one is
    expect(versions()).toHaveLength(1);
    expect(versions()[0].origin.kind).toBe("scripted");
    expect(versions(2)).toHaveLength(1);
    expect(head().origin).toMatchObject({ kind: "bulk", label: "Change speaker to Elder Mo" });

    undoLast();
    expect(versions()).toHaveLength(0);
    expect(versions(2)).toHaveLength(0);
    expect(head().origin.kind).toBe("scripted");
  });

  test("a batch that only flags clips is not a change to the script", () => {
    scriptsStore.applyBulk("cliche", targets(1, 3), {
      kind: "flag",
      flag: "delivery",
      note: "rushed",
      replace: false,
    });
    expect(versions()).toHaveLength(0);
  });

  test("a batch with nothing to change leaves no entry", () => {
    const speaker = segments()[0].speaker;
    scriptsStore.applyBulk("cliche", [{ chId: 1, segId: segments()[0].id }], {
      kind: "speaker",
      speaker,
    });
    expect(versions()).toHaveLength(0);
  });
});

describe("comparing two scripts", () => {
  const seg = (id: number, patch: Partial<Segment> = {}): Segment => ({
    id,
    type: "dialogue",
    speaker: "Ji Ning",
    text: `Line number ${id} as it was first written.`,
    direction: "",
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
    ...patch,
  });

  test("it tells a rewrite from a new line, and says which words moved", () => {
    const from = [seg(1), seg(2), seg(3)];
    const to = [
      seg(1),
      seg(2, { text: "Line number 2 as it was rewritten by hand." }),
      seg(3),
      seg(4, { text: "An entirely different sentence appears here." }),
    ];
    const c = compareScripts(from, to);
    expect(c.counts).toMatchObject({ text: 1, added: 1, removed: 0 });
    expect(c.lines).toBe(2);
    const rewritten = c.changes.find((x) => x.kind === "changed")!;
    expect(rewritten.fromIds).toEqual([2]);
    expect(rewritten.runs.filter((r) => r.kind === "remove").map((r) => r.text.trim())).toEqual([
      "first written.",
    ]);
    expect(rewritten.runs.filter((r) => r.kind === "add").map((r) => r.text.trim())).toEqual([
      "rewritten by hand.",
    ]);
  });

  test("the same words spaced differently is a change, and says so in words", () => {
    const from = [seg(1)];
    const to = [seg(1, { text: "Line number 1 as it was\n\nfirst written." })];
    const c = compareScripts(from, to);
    expect(c.identical).toBe(false);
    expect(c.counts.text).toBe(1);
    // there is no word to mark either side of, so the change is named rather than drawn
    expect(c.changes[0].runs).toHaveLength(0);
    expect(c.changes[0].fields[0].detail).toContain("spaced differently");
  });

  test("speaker, direction, type, expressions and pauses are each their own change", () => {
    const from = [
      seg(1),
      seg(2, { direction: "wary" }),
      seg(3, {
        expressions: [
          { id: "sighs", label: "Sighs", token: "[sighs]", kind: "sound", annotationId: 1, at: 0 },
        ],
      }),
      seg(4, { pause: 1.5 }),
      seg(5, { type: "thought" }),
    ];
    const to = [seg(1, { speaker: "Elder Mo" }), seg(2, { direction: "" }), seg(3), seg(4), seg(5)];
    const c = compareScripts(from, to);
    expect(c.counts).toMatchObject({
      speaker: 1,
      direction: 1,
      expressions: 1,
      pause: 1,
      type: 1,
      added: 0,
      removed: 0,
    });
    const pause = c.changes.find((x) => x.groups.includes("pause"))!.fields[0];
    expect([pause.from, pause.to]).toEqual(["1.5s", "the book’s pause"]);
  });

  test("a line cut in two and two lines joined are recognised as such", () => {
    const whole = seg(1, {
      type: "narration",
      speaker: "Narrator",
      text: "The bell rang three times. Nobody moved.",
    });
    const halves = [
      seg(1, { type: "narration", speaker: "Narrator", text: "The bell rang three times." }),
      seg(2, { type: "narration", speaker: "Narrator", text: "Nobody moved." }),
    ];
    const split = compareScripts([whole, seg(9)], [...halves, seg(9)]);
    expect(split.counts).toMatchObject({ split: 1, added: 0, removed: 0 });
    expect(split.changes[0].toIds).toEqual([1, 2]);
    const joined = compareScripts([...halves, seg(9)], [whole, seg(9)]);
    expect(joined.counts).toMatchObject({ joined: 1, added: 0, removed: 0 });
    expect(joined.changes[0].fromIds).toEqual([1, 2]);
  });

  test("two identical scripts have nothing to report", () => {
    const from = [seg(1), seg(2)];
    expect(compareScripts(from, [seg(1), seg(2)]).identical).toBe(true);
    expect(wordDiff("same words here", "same words here").every((r) => r.kind === "same")).toBe(
      true,
    );
  });
});

describe("restoring", () => {
  /** Narrate the chapter, then move the script on so the clips no longer match it. */
  function narratedThenChanged() {
    narrationStore.runNarration("cliche", [1]);
    drain();
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
    const version = historyStore.saveCheckpoint("cliche", 1, "As narrated")!;
    quiet();
    const spoken = segments().filter((s) => s.type !== "narration");
    scriptsStore.setSpeaker("cliche", 1, spoken[0].id, "Elder Mo");
    scriptsStore.updateSegment("cliche", 1, spoken[1].id, { direction: "much louder" });
    return version;
  }

  test("it keeps the clips that still match, marks the rest, and leaves later versions alone", () => {
    const version = narratedThenChanged();
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
    const plan = historyStore.restorePlanOf("cliche", 1, version.id)!;
    expect(plan.comparison.counts).toMatchObject({ speaker: 1, direction: 1 });
    expect(plan.stale).toBe(0);
    expect(plan.dropped).toBe(0);
    expect(plan.kept).toBe(segments().length);
    expect(plan.narration).toBe("done");

    expect(historyStore.restore("cliche", 1, version.id)).toBe(true);
    expect(segments().every((s) => s.audio.status === "done")).toBe(true);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
    // the restore is one more entry; the version restored from is still there, and so is the
    // script that was current a moment ago
    expect(versions().some((v) => v.id === version.id)).toBe(true);
    expect(head().origin).toMatchObject({ kind: "restored", from: version.id });
    expect(versions()[0].origin).toEqual({ kind: "edited", edits: 2 });
  });

  test("undo puts the script, the audio, the chapter and the history back", () => {
    const version = narratedThenChanged();
    const before = JSON.stringify(segments());
    const entries = versions().length;
    historyStore.restore("cliche", 1, version.id);
    undoLast();
    expect(JSON.stringify(segments())).toBe(before);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
    expect(versions()).toHaveLength(entries);
    expect(head().origin).toEqual({ kind: "edited", edits: 2 });
  });

  test("undoing a restore leaves work done elsewhere in the book alone", () => {
    const version = narratedThenChanged();
    historyStore.restore("cliche", 1, version.id);
    const undoRestore = undos.at(-1)!;
    // while the toast is still up: another chapter edited, and the book's cast changed
    const other = scriptsStore.segmentsOf("cliche", 2);
    scriptsStore.setSpeaker("cliche", 2, other[1].id, "Elder Mo");
    castStore.addAlias("cliche", "Elder Mo", "the old man on the step");
    const elsewhere = JSON.stringify(scriptsStore.segmentsOf("cliche", 2));
    const cast = JSON.stringify(castStore.charactersOf("cliche"));

    undoRestore();
    expect(JSON.stringify(scriptsStore.segmentsOf("cliche", 2))).toBe(elsewhere);
    expect(JSON.stringify(castStore.charactersOf("cliche"))).toBe(cast);
  });

  test("undoing a restore takes back the speakers that restore had to add", () => {
    const spoken = segments().find((s) => s.type === "dialogue")!;
    const was = spoken.speaker;
    const version = historyStore.saveCheckpoint("cliche", 1, "Before the merge")!;
    quiet();
    castStore.mergeCharacter("cliche", was, "Narrator", { silent: true });
    scriptsStore.setSpeaker("cliche", 1, segments()[1].id, "Elder Mo");
    const cast = castStore.charactersOf("cliche").map((c) => c.name);

    historyStore.restore("cliche", 1, version.id);
    expect(castStore.charactersOf("cliche").some((c) => c.name === was)).toBe(true);
    undoLast();
    expect(castStore.charactersOf("cliche").map((c) => c.name)).toEqual(cast);
  });

  test("a clip from a line that was joined away comes back to the line it was rendered for", () => {
    narrationStore.runNarration("cliche", [1]);
    drain();
    const version = historyStore.saveCheckpoint("cliche", 1, "Before the join")!;
    quiet();
    const first = segments()[0];
    const firstText = first.text;
    const rendered = segments()[1].audio.text;
    scriptsStore.joinSegments("cliche", 1, first.id);
    expect(segments().some((s) => s.audio.text === rendered && s.audio.duration > 0)).toBe(false);

    const plan = historyStore.restorePlanOf("cliche", 1, version.id)!;
    expect(plan.comparison.counts.split).toBe(1);
    // the first half's clip was rendered from the first half's words, so it finds its way back;
    // the second half's clip went with the line the join swallowed and cannot
    expect(plan.kept).toBe(version.segments.length - 1);
    expect(plan.unrendered).toBe(1);
    historyStore.restore("cliche", 1, version.id);
    expect(segments()).toHaveLength(version.segments.length);
    expect(segments().filter((s) => s.audio.status === "done")).toHaveLength(
      version.segments.length - 1,
    );
    expect(segments().find((s) => s.text === firstText)!.audio.duration).toBeGreaterThan(0);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
  });

  test("restoring the same script again does nothing at all", () => {
    const version = historyStore.saveCheckpoint("cliche", 1, "Untouched")!;
    expect(historyStore.restore("cliche", 1, version.id)).toBe(false);
    expect(versions()).toHaveLength(1);
    expect(head().origin.kind).toBe("checkpoint");
  });

  test("a speaker the book's cast has lost comes back as one to review", () => {
    const spoken = segments().find((s) => s.type === "dialogue")!;
    const was = spoken.speaker;
    const version = historyStore.saveCheckpoint("cliche", 1, "Before the merge")!;
    quiet();
    castStore.mergeCharacter("cliche", was, "Narrator", { silent: true });
    expect(castStore.charactersOf("cliche").some((c) => c.name === was)).toBe(false);

    const plan = historyStore.restorePlanOf("cliche", 1, version.id)!;
    expect(plan.missingSpeakers.map((m) => m.name)).toContain(was);
    historyStore.restore("cliche", 1, version.id);
    const back = castStore.charactersOf("cliche").find((c) => c.name === was);
    expect(back?.isNew).toBe(true);
  });

  test("a run in flight is not raced: the restore waits for it", () => {
    const version = historyStore.saveCheckpoint("cliche", 1, "Before the run")!;
    quiet();
    scriptsStore.setSpeaker("cliche", 1, segments()[1].id, "Elder Mo");
    narrationStore.runNarration("cliche", [1]);
    tick();
    expect(historyStore.busyJobs("cliche", 1)).toHaveLength(1);
    expect(historyStore.restore("cliche", 1, version.id)).toBe(false);
    expect(head().origin.kind).not.toBe("restored");

    jobsStore.cancelJob(jobsStore.jobs[0].id);
    drain();
    expect(historyStore.busyJobs("cliche", 1)).toHaveLength(0);
    expect(historyStore.restore("cliche", 1, version.id)).toBe(true);
  });
});

describe("the book the history belongs to", () => {
  test("renumbering a book's chapters takes each history with its own chapter", () => {
    const book = libraryStore.bookById("cliche")!;
    const first = book.volumes[0];
    const gone = libraryStore.chaptersOf("cliche").filter((c) => c.volumeId === first.id).length;
    const chId = gone + 2; // a chapter in a volume that stays, two along from the join
    const mark = historyStore.saveCheckpoint("cliche", chId, "Before the volume went")!;
    expect(mark).toBeTruthy();
    const script = scriptSignature(scriptsStore.segmentsOf("cliche", chId));

    libraryStore.removeVolume("cliche", first.id);
    const now = chId - gone;
    expect(scriptSignature(scriptsStore.segmentsOf("cliche", now))).toBe(script);
    // the history followed the script, and nothing was left behind under the old number for the
    // chapter that now carries it to inherit
    expect(historyStore.versionsOf("cliche", now).map((v) => v.origin)).toEqual([mark.origin]);
    expect(historyStore.versionsOf("cliche", chId)).toHaveLength(0);

    undoLast();
    expect(historyStore.versionsOf("cliche", chId).map((v) => v.id)).toEqual([mark.id]);
    expect(historyStore.versionsOf("cliche", now)).toHaveLength(0);
  });

  test("a novel that is removed takes its chapters' histories with it, and brings them back", () => {
    historyStore.saveCheckpoint("cliche", 1, "Kept");
    historyStore.saveCheckpoint("cliche", 2, "Kept too");
    libraryStore.removeBook("cliche");
    expect(Object.keys(historyStore.chapters).filter((k) => k.startsWith("cliche:"))).toHaveLength(
      0,
    );

    undoLast();
    expect(versions().map((v) => v.origin)).toMatchObject([{ name: "Kept" }]);
    expect(versions(2).map((v) => v.origin)).toMatchObject([{ name: "Kept too" }]);
  });
});

describe("the demo world", () => {
  test("the seeded chapter history is there to preview, compare and restore", () => {
    expect(demoStore.applyScenario("script-history")).toContain("history=1");
    const saved = versions();
    expect(saved).toHaveLength(3);
    expect(saved.map((v) => v.origin.kind)).toEqual(["edited", "checkpoint", "scripted"]);
    expect(head().origin).toMatchObject({ kind: "scripted", again: true, profile: "DeepSeek" });

    const checkpoint = saved.find((v) => v.origin.kind === "checkpoint")!;
    const c = historyStore.comparisonOf("cliche", 1, checkpoint.id)!;
    expect(c.counts.speaker).toBe(3);
    expect(c.counts.direction).toBe(2);
    expect(c.counts.split).toBe(1);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");

    const plan = historyStore.restorePlanOf("cliche", 1, checkpoint.id)!;
    expect(plan.stale).toBe(0);
    expect(plan.dropped).toBe(0);
    expect(plan.unrendered).toBe(0);
    expect(plan.kept).toBeGreaterThan(5);
    expect(plan.narration).toBe("done");
    historyStore.restore("cliche", 1, checkpoint.id);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
    expect(segments().some((s) => s.audio.status === "stale")).toBe(false);
  });

  test("the first pass is a version of its own, with the alias the cast never had", () => {
    demoStore.applyScenario("script-history");
    const first = versions().at(-1)!;
    expect(first.origin).toMatchObject({ kind: "scripted", profile: "OpenAI" });
    const plan = historyStore.restorePlanOf("cliche", 1, first.id)!;
    expect(plan.missingSpeakers.length).toBeGreaterThan(0);
    expect(plan.comparison.lines).toBeGreaterThan(4);
    expect(plan.comparison.counts.text).toBeGreaterThan(0);
  });

  test("a reset clears the history and drops the editing session still collecting", () => {
    demoStore.applyScenario("script-history");
    expect(versions().length).toBeGreaterThan(0);
    scriptsStore.updateSegment("cliche", 1, segments()[1].id, { direction: "under her breath" });
    expect(head().open).toBe(true);
    expect(timers.size).toBeGreaterThan(0);

    demoStore.resetDemo();
    expect(versions()).toHaveLength(0);
    expect(head().origin).toEqual({ kind: "scripted" });
    // the session timer belonged to the world that has just been replaced
    expect(timers.size).toBe(0);
    drain();
    expect(versions()).toHaveLength(0);
  });

  test("a session callback from a replaced world cannot close one in the new world", () => {
    scriptsStore.updateSegment("cliche", 1, segments()[1].id, { direction: "wary" });
    const pending = [...timers.values()];
    demoStore.resetDemo();
    scriptsStore.updateSegment("cliche", 1, segments()[1].id, { direction: "flat" });
    expect(head().open).toBe(true);
    for (const t of pending) t.fn();
    expect(head().open).toBe(true);
  });
});
