// Segment boundary corrections: splitting a line in two, joining two, deleting one. Each is an
// edit of the chapter's script the store makes at once and writes behind, so these read the demo
// library's narrated first chapter of The Cliché Cultivation World and check what the edit left
// here; what the server keeps of an edit is `tests/server/scriptEdit.test.ts`'s.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import { silenceOf } from "@/lib/speech";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import type { Segment, ToastOptions } from "@/types";
import { demoServer, type DemoServer } from "./support/demoServer";
import { testPinia, type TestPinia } from "./support/pinia";

let demo: DemoServer;
let pinia: TestPinia;
let undos: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  demo = await demoServer();
});
beforeEach(async () => {
  await demo.reset();
  pinia = testPinia();
  castStore = useCastStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptsStore = useScriptsStore();
  undos = [];
  useUiStore().toast = ((_msg: string, opts?: ToastOptions) => {
    if (opts?.undo) undos.push(opts.undo);
    return "test";
  }) as ReturnType<typeof useUiStore>["toast"];
  // the book and the two chapters these read, as the reader would have them
  const svc = libraryService();
  await libraryStore.loadBook("cliche");
  for (const chId of [1, 7])
    scriptsStore._install("cliche", chId, await svc.chapterScript("cliche", chId));
});
// an edit's write is still on its way when a test ends; it must not land on the next test's demo
afterEach(async () => {
  await Promise.all([1, 7].map((chId) => scriptsStore._settled("cliche", chId)));
  pinia.stop();
});

const narrated = (bookId: string, chId: number): Segment[] =>
  scriptsStore.segmentsOf(bookId, chId).filter((s) => s.audio.duration > 0);
/** what the finished chapter lasts: every clip plus the silence stitched between them */
const stitched = (bookId: string, chId: number): number => {
  const segs = scriptsStore.segmentsOf(bookId, chId);
  return (
    segs.reduce((a, s) => a + s.audio.duration, 0) + silenceOf(segs, castStore.pacingOf(bookId))
  );
};

test("splitting keeps every character of the prose and invalidates only the audio it touches", () => {
  const segs = scriptsStore.segmentsOf("cliche", 1);
  const count = segs.length;
  const before = segs.map((s) => s.text).join("|");
  const target = segs.find((s) => s.text.split(" ").length > 6)!;
  const whole = target.text;
  const at = whole.split(" ").slice(0, 3).join(" ").length + 1;
  const otherDuration = segs.find((s) => s !== target)!.audio.duration;

  const id = scriptsStore.splitSegment("cliche", 1, target.id, at)!;
  const after = scriptsStore.segmentsOf("cliche", 1);
  const second = after.find((s) => s.id === id)!;

  expect(after).toHaveLength(count + 1);
  expect(after.indexOf(second)).toBe(after.indexOf(target) + 1);
  expect(`${target.text} ${second.text}`).toBe(whole);
  expect(target.edited && second.edited).toBe(true);
  // the first half has a clip that no longer matches its text; the second half has none at all
  expect(target.audio.status).toBe("stale");
  expect(target.audio.text).not.toBe(target.text);
  expect(second.audio.status).toBe("none");
  expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
  expect(after.find((s) => s !== target && s !== second)!.audio.duration).toBe(otherDuration);

  undos.pop()!();
  expect(
    scriptsStore
      .segmentsOf("cliche", 1)
      .map((s) => s.text)
      .join("|"),
  ).toBe(before);
  expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
});

test("a hand-split chunk stops being the model's unverified guess", () => {
  const chunk = scriptsStore.segmentsOf("cliche", 7).find((s) => s.fallback)!;
  const id = scriptsStore.splitSegment("cliche", 7, chunk.id, chunk.text.indexOf(" ", 40) + 1)!;
  const second = scriptsStore.segmentsOf("cliche", 7).find((s) => s.id === id)!;
  expect(chunk.fallback).toBeUndefined();
  expect(second.fallback).toBeUndefined();
  expect(second.fallbackMismatch).toBeUndefined();
});

test("splitting refuses a cut that would leave an empty half", () => {
  const s = scriptsStore.segmentsOf("cliche", 1)[0];
  const n = scriptsStore.segmentsOf("cliche", 1).length;
  expect(scriptsStore.splitSegment("cliche", 1, s.id, 0)).toBeNull();
  expect(scriptsStore.splitSegment("cliche", 1, s.id, s.text.length)).toBeNull();
  expect(scriptsStore.segmentsOf("cliche", 1)).toHaveLength(n);
});

test("joining folds the next line into this one and the first speaker wins", () => {
  const segs = scriptsStore.segmentsOf("cliche", 1);
  const count = segs.length;
  const i = segs.findIndex((s, k) => k > 0 && s.speaker !== segs[k - 1].speaker);
  const a = segs[i - 1];
  const b = segs[i];
  const joined = `${a.text} ${b.text}`;
  narrationStore.flagSegment("cliche", 1, b.id, "delivery", "too fast");

  expect(scriptsStore.joinSegments("cliche", 1, a.id)).toBe(true);
  const after = scriptsStore.segmentsOf("cliche", 1);
  expect(after).toHaveLength(count - 1);
  expect(after.some((s) => s.id === b.id)).toBe(false);
  expect(a.text).toBe(joined);
  expect(a.speaker).not.toBe(b.speaker);
  expect(a.audio.status).toBe("stale");
  expect(a.flag?.note).toBe("too fast"); // the complaint follows the text it was made about

  undos.pop()!();
  expect(scriptsStore.segmentsOf("cliche", 1)).toHaveLength(count);
  expect(scriptsStore.segmentsOf("cliche", 1)[i].speaker).toBe(b.speaker);
});

test("deleting a line takes it out of the chapter, and the undo puts it back in place", () => {
  const segs = scriptsStore.segmentsOf("cliche", 1);
  const count = segs.length;
  const before = segs.map((s) => s.text);
  const gone = segs[2];

  expect(scriptsStore.deleteSegment("cliche", 1, gone.id)).toBe(true);
  const after = scriptsStore.segmentsOf("cliche", 1);
  expect(after).toHaveLength(count - 1);
  expect(after.some((s) => s.id === gone.id)).toBe(false);

  undos.pop()!();
  expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.text)).toEqual(before);
});

test("a chapter keeps its last line — there would be nothing left to narrate", () => {
  const segs = scriptsStore.segmentsOf("cliche", 1);
  for (const s of segs.slice(1)) expect(scriptsStore.deleteSegment("cliche", 1, s.id)).toBe(true);
  const last = scriptsStore.segmentsOf("cliche", 1)[0];
  expect(scriptsStore.deleteSegment("cliche", 1, last.id)).toBe(false);
  expect(scriptsStore.segmentsOf("cliche", 1)).toHaveLength(1);
});

test("dropping a rendered line leaves the finished chapter stale and retimed", () => {
  const gone = narrated("cliche", 1)[1];
  expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");

  scriptsStore.deleteSegment("cliche", 1, gone.id);
  expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
  expect(libraryStore.chapter("cliche", 1)!.duration).toBeCloseTo(stitched("cliche", 1), 10);
});

test("a rewritten line keeps its place and goes stale", () => {
  const target = narrated("cliche", 1)[1];
  const count = scriptsStore.segmentsOf("cliche", 1).length;

  scriptsStore.updateSegment("cliche", 1, target.id, { text: "Trimmed." });
  const after = scriptsStore.segmentsOf("cliche", 1);
  expect(after).toHaveLength(count);
  expect(after.find((s) => s.id === target.id)!.text).toBe("Trimmed.");
  expect(target.edited).toBe(true);
  expect(target.audio.status).toBe("stale");
});

test("the last segment has nothing to join into", () => {
  const last = scriptsStore.segmentsOf("cliche", 1).at(-1)!;
  expect(scriptsStore.joinSegments("cliche", 1, last.id)).toBe(false);
});

test("a paragraph break survives a split, and the join that undoes it puts the break back", () => {
  const segs = scriptsStore.segmentsOf("cliche", 1);
  const target = segs.find((s) => s.text.split(" ").length > 6)!;
  const head = target.text.split(" ").slice(0, 3).join(" ");
  // the source had a paragraph break where the cut falls, not a single space
  target.text = `${head}\n\n${target.text.slice(head.length).trimStart()}`;
  const whole = target.text;

  const id = scriptsStore.splitSegment("cliche", 1, target.id, head.length + 2)!;
  const second = scriptsStore.segmentsOf("cliche", 1).find((s) => s.id === id)!;
  expect(target.text).toBe(head); // neither half carries the whitespace around
  expect(second.text).toBe(whole.slice(head.length + 2));
  expect(target.sep).toBe("\n\n");

  scriptsStore.joinSegments("cliche", 1, target.id);
  expect(scriptsStore.segmentsOf("cliche", 1).find((s) => s.id === id)).toBeUndefined();
  expect(target.text).toBe(whole); // character for character, break included
  expect(target.sep).toBeUndefined();
});
