// Bulk script corrections from the Search page: previewing changes nothing, applying touches exactly
// the lines the preview counted, and one undo puts the batch back without stepping on later edits.
// They run on the demo library's The Cliché Cultivation World, whose first chapter is narrated.
//
// What a batch does here is the store's; what the server keeps of the write it sends is
// `tests/server/scriptEdit.test.ts`'s. So the write is recorded rather than sent, and the seeded
// demo is opened once and never changed: every test reads the same book.
import { test, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { bulkOutcome, segmentFingerprint, directionOptions } from "@/lib/bulk";
import { libraryService } from "@/services/library";
import type { BulkTarget, Segment, UndoEntry } from "@/types";
import { demoServer } from "./support/demoServer";
import { testPinia, type TestPinia } from "./support/pinia";
import { unwrittenEdits, type UnwrittenEdit, type UnwrittenFlag } from "./support/unwrittenEdits";

// The batch undo is the store's own undo stack, and that stack lives on a toast. Swap the toast
// library for a silent one so `revertEntry` can be exercised for real.
let shown = 0;
mock.module("vue-toastflow", () => ({
  toast: {
    show: () => String(++shown),
    dismiss: () => {},
    loading: (f: () => Promise<unknown>) => f(),
  },
}));

const { useLibraryStore } = await import("@/stores/library");
const { useNarrationStore } = await import("@/stores/narration");
const { useScriptsStore } = await import("@/stores/scripts");
const { useUiStore } = await import("@/stores/ui");

let pinia: TestPinia;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;
/** the scripts the store asked the server to write, in the order it asked */
let writes: UnwrittenEdit[];
/** the lines' flags it asked to write */
let flags: UnwrittenFlag[];
/** the chapters these read: narrated, narrated with stale lines, and scripted only */
const CHAPTERS = [1, 2, 5];

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  await demoServer();
  ({ writes, flags } = unwrittenEdits());
});
beforeEach(async () => {
  pinia = testPinia();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  writes.length = 0;
  flags.length = 0;
  const svc = libraryService();
  await libraryStore.loadBook("cliche");
  for (const chId of CHAPTERS)
    scriptsStore._install("cliche", chId, await svc.chapterScript("cliche", chId));
});
// a batch's write is still being answered when a test ends; it must not land in the next test
afterEach(async () => {
  await Promise.all(CHAPTERS.map((chId) => scriptsStore._settled("cliche", chId)));
  pinia.stop();
});

/** Every line of a chapter, as selection targets. */
const all = (chId: number): BulkTarget[] =>
  scriptsStore.segmentsOf("cliche", chId).map((s) => ({ chId, segId: s.id }));
const seg = (chId: number, segId: number): Segment =>
  scriptsStore.segmentsOf("cliche", chId).find((s) => s.id === segId)!;
const snapshot = (chId: number): string =>
  scriptsStore
    .segmentsOf("cliche", chId)
    .map((s) => segmentFingerprint(s))
    .join("|");

test("the preview counts what will change and what already matches, and mutates nothing", () => {
  const targets = all(1);
  const speaker = seg(1, targets[0].segId).speaker;
  const before = snapshot(1);

  const p = scriptsStore.bulkPreview("cliche", targets, { kind: "speaker", speaker });
  const already = scriptsStore.segmentsOf("cliche", 1).filter((s) => s.speaker === speaker).length;

  expect(p.selected).toBe(targets.length);
  expect(p.chapters).toBe(1);
  expect(p.changing).toBe(targets.length - already);
  expect(p.skipped).toBe(already);
  expect(p.skipReason).toBe(`already use ${speaker}`);
  expect(p.confirm).toBe(`Change ${p.changing} lines`);
  expect(p.rows).toHaveLength(targets.length);
  expect(snapshot(1)).toBe(before); // previewing is a read
});

test("a batch where every selected line already has the value offers nothing to apply", () => {
  const speaker = "Ji Ning";
  const targets = scriptsStore
    .segmentsOf("cliche", 1)
    .filter((s) => s.speaker === speaker)
    .map((s) => ({ chId: 1, segId: s.id }));
  expect(targets.length).toBeGreaterThan(0);

  const p = scriptsStore.bulkPreview("cliche", targets, { kind: "speaker", speaker });
  expect(p.changing).toBe(0);
  expect(p.skipped).toBe(targets.length);
  expect(p.confirm).toBe("Change 0 lines");

  const before = snapshot(1);
  const res = scriptsStore.applyBulk("cliche", targets, { kind: "speaker", speaker });
  expect(res.changed).toBe(0);
  expect(res.entry).toBeNull();
  expect(snapshot(1)).toBe(before);
});

test("changing the speaker in bulk edits only the counted lines and stales their rendered clips", () => {
  const targets = all(1); // chapter 1 of Cliché is narrated, so every clip is done
  const p = scriptsStore.bulkPreview("cliche", targets, { kind: "speaker", speaker: "Elder Mo" });
  const untouched = scriptsStore.segmentsOf("cliche", 2).map((s) => s.audio.status);

  const res = scriptsStore.applyBulk("cliche", targets, { kind: "speaker", speaker: "Elder Mo" });

  expect(res.changed).toBe(p.changing);
  expect(res.stale).toBe(p.stale);
  expect(p.stale).toBeGreaterThan(0);
  const changed = scriptsStore.segmentsOf("cliche", 1).filter((s) => s.speaker === "Elder Mo");
  expect(changed).toHaveLength(scriptsStore.segmentsOf("cliche", 1).length);
  expect(changed.every((s) => s.edited)).toBe(true);
  expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
  // a chapter nobody selected is left alone
  expect(scriptsStore.segmentsOf("cliche", 2).map((s) => s.audio.status)).toEqual(untouched);
  // the batch is written once, under its own name, so the history keeps it as one entry
  expect(writes.map((w) => [w.chId, w.edit.origin])).toEqual([
    [1, { kind: "bulk", label: p.label, lines: p.changing }],
  ]);
});

test("undo restores speakers, edited marks, clip status and the chapter's narration state", () => {
  const targets = all(1);
  const speakers = scriptsStore.segmentsOf("cliche", 1).map((s) => s.speaker);
  const statuses = scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status);
  const edits = scriptsStore.segmentsOf("cliche", 1).map((s) => s.edited);
  const narration = libraryStore.chapter("cliche", 1)!.narration;

  const res = scriptsStore.applyBulk("cliche", targets, { kind: "speaker", speaker: "Elder Mo" });
  expect(uiStore.undoPending(res.entry)).toBe(true);
  uiStore.revertEntry(res.entry as UndoEntry);

  expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.speaker)).toEqual(speakers);
  expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status)).toEqual(statuses);
  expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.edited)).toEqual(edits);
  expect(libraryStore.chapter("cliche", 1)!.narration).toBe(narration);
  expect(uiStore.undoPending(res.entry)).toBe(false); // the batch's undo is taken once
});

test("undoing a batch writes every chapter it changed back as it was", async () => {
  // a batch across two chapters, so a chapter the undo forgets to write is one the other hides
  const targets = [...all(1), ...all(5)];
  const original = [1, 5].map((chId) =>
    JSON.parse(JSON.stringify(scriptsStore.segmentsOf("cliche", chId))),
  );
  const res = scriptsStore.applyBulk("cliche", targets, { kind: "speaker", speaker: "Elder Mo" });
  await Promise.all([1, 5].map((chId) => scriptsStore._settled("cliche", chId)));
  const batch = writes.length;

  uiStore.revertEntry(res.entry as UndoEntry);
  await Promise.all([1, 5].map((chId) => scriptsStore._settled("cliche", chId)));

  // undo is on the page at once, but it is only kept if it reaches the server: without these
  // writes the next read of the book would hand the batch back
  const back = writes.slice(batch);
  expect(back.map((w) => w.chId).toSorted()).toEqual([1, 5]);
  for (const [i, chId] of [1, 5].entries())
    expect(back.find((w) => w.chId === chId)!.edit.segments).toEqual(original[i]);
});

test("undo leaves alone a line that was edited after the batch", () => {
  const targets = all(1);
  const victim = targets[0];
  const res = scriptsStore.applyBulk("cliche", targets, { kind: "speaker", speaker: "Elder Mo" });

  // someone corrects one of the batch's lines by hand afterwards
  scriptsStore.setSpeaker("cliche", victim.chId, victim.segId, "Xiao Lan");
  uiStore.revertEntry(res.entry as UndoEntry);

  expect(seg(victim.chId, victim.segId).speaker).toBe("Xiao Lan");
  expect(seg(1, targets[1].segId).speaker).not.toBe("Elder Mo");
});

test("setting a direction replaces existing ones; clearing is its own action", () => {
  const targets = all(5);
  const had = scriptsStore.segmentsOf("cliche", 5).filter((s) => s.direction).length;
  expect(had).toBeGreaterThan(0);

  scriptsStore.applyBulk("cliche", targets, {
    kind: "direction",
    mode: "set",
    direction: "weary, slow",
  });
  expect(scriptsStore.segmentsOf("cliche", 5).every((s) => s.direction === "weary, slow")).toBe(
    true,
  );

  const cleared = scriptsStore.applyBulk("cliche", targets, {
    kind: "direction",
    mode: "clear",
    direction: "",
  });
  expect(cleared.changed).toBe(targets.length);
  expect(scriptsStore.segmentsOf("cliche", 5).every((s) => s.direction === "")).toBe(true);

  // clearing again has nothing to do, and says so
  const again = scriptsStore.bulkPreview("cliche", targets, {
    kind: "direction",
    mode: "clear",
    direction: "",
  });
  expect(again.changing).toBe(0);
  expect(again.skipReason).toBe("have no direction to clear");
});

test("a bulk correction leaves the prose and its expression annotations untouched", () => {
  const targets = all(1);
  seg(1, targets[0].segId).expressions = [
    {
      id: "laughter",
      label: "Laughter",
      token: "[laughter]",
      kind: "sound",
      annotationId: 1,
      at: 0,
    },
  ];
  const text = scriptsStore.segmentsOf("cliche", 1).map((s) => s.text);
  const marks = scriptsStore
    .segmentsOf("cliche", 1)
    .map((s) => JSON.stringify(s.expressions ?? null));

  scriptsStore.applyBulk("cliche", targets, {
    kind: "direction",
    mode: "set",
    direction: "trembling",
  });

  expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.text)).toEqual(text);
  expect(
    scriptsStore.segmentsOf("cliche", 1).map((s) => JSON.stringify(s.expressions ?? null)),
  ).toEqual(marks);
});

test("flagging keeps existing flags unless replacement is chosen, and stales nothing", () => {
  const targets = all(1);
  narrationStore.flagSegment("cliche", 1, targets[0].segId, "pause", "keep me");
  const statuses = scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status);

  const keep = scriptsStore.bulkPreview("cliche", targets, {
    kind: "flag",
    flag: "delivery",
    note: "whole scene",
    replace: false,
  });
  expect(keep.changing).toBe(targets.length - 1);
  expect(keep.skipReason).toBe("are already flagged — their flags are kept");
  expect(keep.stale).toBe(0);

  const res = scriptsStore.applyBulk("cliche", targets, {
    kind: "flag",
    flag: "delivery",
    note: "whole scene",
    replace: false,
  });
  expect(res.stale).toBe(0);
  expect(seg(1, targets[0].segId).flag).toMatchObject({ kind: "pause", note: "keep me" });
  expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status)).toEqual(statuses);

  const replaced = scriptsStore.bulkPreview("cliche", targets, {
    kind: "flag",
    flag: "delivery",
    note: "whole scene",
    replace: true,
  });
  expect(replaced.changing).toBe(1); // only the one that still differs
});

test("selected lines that no longer exist are reported, not applied", () => {
  const targets = [...all(1), { chId: 1, segId: 9999 }];
  const p = scriptsStore.bulkPreview("cliche", targets, { kind: "speaker", speaker: "Elder Mo" });
  expect(p.missing).toBe(1);
  expect(p.selected).toBe(targets.length);
  expect(p.rows).toHaveLength(targets.length - 1);
});

test("bulkOutcome names why a line is skipped", () => {
  const s = seg(1, 1);
  expect(bulkOutcome(s, { kind: "speaker", speaker: s.speaker }).skip).toBe("same-speaker");
  expect(bulkOutcome(s, { kind: "direction", mode: "set", direction: s.direction }).skip).toBe(
    "same-direction",
  );
  expect(
    bulkOutcome({ ...s, direction: "" }, { kind: "direction", mode: "clear", direction: "" }).skip,
  ).toBe("no-direction");
});

test("direction options list the book's own directions first, once each", () => {
  const opts = directionOptions(scriptsStore.segments, "cliche");
  expect(opts[0].group).toBe("Used in this book");
  expect(opts[0].hint).toMatch(/\d+/);
  expect(new Set(opts.map((o) => o.value)).size).toBe(opts.length);
  // a book that has never been scripted offers the presets alone
  const fresh = directionOptions(scriptsStore.segments, "nothing-here");
  expect(fresh.every((o) => o.group === "Presets")).toBe(true);
  expect(fresh.length).toBeGreaterThan(0);
});

test("a clip finishing in the background does not invalidate an open preview, but an edit does", () => {
  const targets = all(1);
  const action = { kind: "speaker", speaker: "Elder Mo" } as const;
  const first = scriptsStore.bulkPreview("cliche", targets, action).signature;

  // audio moving on its own is not a reason to re-read the numbers
  seg(1, targets[0].segId).audio.status = "failed";
  expect(scriptsStore.bulkPreview("cliche", targets, action).signature).toBe(first);

  // someone editing one of the selected lines is
  scriptsStore.updateSegment("cliche", 1, targets[0].segId, { direction: "cold and clipped" });
  expect(scriptsStore.bulkPreview("cliche", targets, action).signature).not.toBe(first);
});

// A narration run moves the chapter's revision on with every clip, so a flag batch sent as the
// script, naming the revision it read, was refused while the chapter narrated.
test("a flag batch writes each line's flag alone and no script, and its undo takes them down the same way", async () => {
  const targets = all(5);
  const res = scriptsStore.applyBulk("cliche", targets, {
    kind: "flag",
    flag: "pause",
    note: "check the beat",
    replace: false,
  });
  await scriptsStore._settled("cliche", 5);
  expect(writes).toEqual([]);
  expect(flags.map((f) => [f.segId, f.flag?.kind])).toEqual(targets.map((t) => [t.segId, "pause"]));

  flags.length = 0;
  uiStore.revertEntry(res.entry as UndoEntry);
  await scriptsStore._settled("cliche", 5);
  expect(writes).toEqual([]);
  expect(flags.map((f) => [f.segId, f.flag])).toEqual(targets.map((t) => [t.segId, null]));
});

test("undoing a flag batch survives a clip that rendered in the meantime", () => {
  const targets = all(5); // chapter 5 is scripted but not narrated
  const res = scriptsStore.applyBulk("cliche", targets, {
    kind: "flag",
    flag: "pause",
    note: "check the beat",
    replace: false,
  });
  expect(res.changed).toBe(targets.length);

  // narration finishes under the batch — nothing to do with the flags
  seg(5, targets[0].segId).audio.status = "done";
  uiStore.revertEntry(res.entry as UndoEntry);

  expect(scriptsStore.segmentsOf("cliche", 5).every((s) => !s.flag)).toBe(true);
  expect(seg(5, targets[0].segId).audio.status).toBe("done"); // and the clip is left alone
});
