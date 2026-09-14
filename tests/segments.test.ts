// Segment boundary corrections (split / join) and audio review (flag → retake → keep one take).
// The narration simulation runs on setTimeout, so the clock and both timer APIs are faked here.
import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useApp } from "../src/stores/app";
import { silenceOf } from "../src/lib/speech";
import type { Segment, ToastOptions } from "../src/types";

let timers = new Map<number, () => void>();
let clock = 1000;
let restore: (() => void)[] = [];
let undos: (() => void)[] = [];
let app: ReturnType<typeof useApp>;

/** Fire every pending timer until the queue drains; delays are ignored, order is kept. */
function run(rounds = 400): void {
  for (let i = 0; i < rounds && timers.size; i++) {
    clock += 500;
    const pending = [...timers]; // timers scheduled by these callbacks wait for the next round
    for (const [id, fn] of pending) {
      if (!timers.has(id)) continue;
      timers.delete(id);
      fn();
    }
  }
  expect(timers.size).toBe(0);
}

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  app = useApp();
  app.jobs = [];
  undos = [];
  app.toast = ((_msg: string, opts?: ToastOptions) => {
    if (opts?.undo) undos.push(opts.undo);
    return "test";
  }) as typeof app.toast;
  for (const e of app.endpoints) {
    e.enabled = true;
    e.needsKey = false;
    e.failRate = 0;
    e.backoffUntil = 0;
  }
  timers = new Map();
  clock = 1000;
  let seq = 0;
  restore = [
    spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    }) as unknown as typeof setTimeout),
    spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout),
    spyOn(Date, "now").mockImplementation(() => clock),
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((fn) => fn()));

const narrated = (bookId: string, chId: number): Segment[] =>
  app.segmentsOf(bookId, chId).filter((s) => s.audio.duration > 0);
/** what the finished chapter lasts: every clip plus the silence stitched between them */
const stitched = (bookId: string, chId: number): number => {
  const segs = app.segmentsOf(bookId, chId);
  return segs.reduce((a, s) => a + s.audio.duration, 0) + silenceOf(segs, app.pacingOf(bookId));
};

test("splitting keeps every character of the prose and invalidates only the audio it touches", () => {
  const segs = app.segmentsOf("cliche", 1);
  const count = segs.length;
  const before = segs.map((s) => s.text).join("|");
  const target = segs.find((s) => s.text.split(" ").length > 6)!;
  const whole = target.text;
  const at = whole.split(" ").slice(0, 3).join(" ").length + 1;
  const otherDuration = segs.find((s) => s !== target)!.audio.duration;

  const id = app.splitSegment("cliche", 1, target.id, at)!;
  const after = app.segmentsOf("cliche", 1);
  const second = after.find((s) => s.id === id)!;

  expect(after).toHaveLength(count + 1);
  expect(after.indexOf(second)).toBe(after.indexOf(target) + 1);
  expect(`${target.text} ${second.text}`).toBe(whole);
  expect(target.edited && second.edited).toBe(true);
  // the first half has a clip that no longer matches its text; the second half has none at all
  expect(target.audio.status).toBe("stale");
  expect(target.audio.text).not.toBe(target.text);
  expect(second.audio.status).toBe("none");
  expect(app.chapter("cliche", 1)!.narration).toBe("stale");
  expect(after.find((s) => s !== target && s !== second)!.audio.duration).toBe(otherDuration);

  undos.pop()!();
  expect(
    app
      .segmentsOf("cliche", 1)
      .map((s) => s.text)
      .join("|"),
  ).toBe(before);
  expect(app.chapter("cliche", 1)!.narration).toBe("done");
});

test("a hand-split chunk stops being the model's unverified guess", () => {
  const chunk = app.segmentsOf("cliche", 7).find((s) => s.fallback)!;
  const id = app.splitSegment("cliche", 7, chunk.id, chunk.text.indexOf(" ", 40) + 1)!;
  const second = app.segmentsOf("cliche", 7).find((s) => s.id === id)!;
  expect(chunk.fallback).toBeUndefined();
  expect(second.fallback).toBeUndefined();
  expect(second.fallbackMismatch).toBeUndefined();
});

test("splitting refuses a cut that would leave an empty half", () => {
  const s = app.segmentsOf("cliche", 1)[0];
  const n = app.segmentsOf("cliche", 1).length;
  expect(app.splitSegment("cliche", 1, s.id, 0)).toBeNull();
  expect(app.splitSegment("cliche", 1, s.id, s.text.length)).toBeNull();
  expect(app.segmentsOf("cliche", 1)).toHaveLength(n);
});

test("joining folds the next line into this one and the first speaker wins", () => {
  const segs = app.segmentsOf("cliche", 1);
  const count = segs.length;
  const i = segs.findIndex((s, k) => k > 0 && s.speaker !== segs[k - 1].speaker);
  const a = segs[i - 1];
  const b = segs[i];
  const joined = `${a.text} ${b.text}`;
  app.flagSegment("cliche", 1, b.id, "delivery", "too fast");

  expect(app.joinSegments("cliche", 1, a.id)).toBe(true);
  const after = app.segmentsOf("cliche", 1);
  expect(after).toHaveLength(count - 1);
  expect(after.some((s) => s.id === b.id)).toBe(false);
  expect(a.text).toBe(joined);
  expect(a.speaker).not.toBe(b.speaker);
  expect(a.audio.status).toBe("stale");
  expect(a.flag?.note).toBe("too fast"); // the complaint follows the text it was made about

  undos.pop()!();
  expect(app.segmentsOf("cliche", 1)).toHaveLength(count);
  expect(app.segmentsOf("cliche", 1)[i].speaker).toBe(b.speaker);
});

test("the last segment has nothing to join into", () => {
  const last = app.segmentsOf("cliche", 1).at(-1)!;
  expect(app.joinSegments("cliche", 1, last.id)).toBe(false);
});

test("“re-narrate changed” renders edited lines and unrendered halves of a split", () => {
  const target = narrated("cliche", 1)[2];
  app.splitSegment("cliche", 1, target.id, target.text.indexOf(" ", 10) + 1);
  run();
  expect(app.segmentsOf("cliche", 1).some((s) => s.audio.status === "none")).toBe(true);

  app.renarrateStale("cliche", 1);
  run();
  const after = app.segmentsOf("cliche", 1);
  expect(after.every((s) => s.audio.status === "done")).toBe(true);
  expect(app.chapter("cliche", 1)!.narration).toBe("done");
  expect(after.every((s) => s.audio.text === s.text)).toBe(true);
  expect(app.chapter("cliche", 1)!.duration).toBeCloseTo(stitched("cliche", 1), 10);
});

test("a paragraph break survives a split, and the join that undoes it puts the break back", () => {
  const segs = app.segmentsOf("cliche", 1);
  const target = segs.find((s) => s.text.split(" ").length > 6)!;
  const head = target.text.split(" ").slice(0, 3).join(" ");
  // the source had a paragraph break where the cut falls, not a single space
  target.text = `${head}\n\n${target.text.slice(head.length).trimStart()}`;
  const whole = target.text;

  const id = app.splitSegment("cliche", 1, target.id, head.length + 2)!;
  const second = app.segmentsOf("cliche", 1).find((s) => s.id === id)!;
  expect(target.text).toBe(head); // neither half carries the whitespace around
  expect(second.text).toBe(whole.slice(head.length + 2));
  expect(target.sep).toBe("\n\n");

  app.joinSegments("cliche", 1, target.id);
  expect(app.segmentsOf("cliche", 1).find((s) => s.id === id)).toBeUndefined();
  expect(target.text).toBe(whole); // character for character, break included
  expect(target.sep).toBeUndefined();
});

test("a retake renders beside the clip in the book and decides nothing on its own", () => {
  const s = narrated("cliche", 1)[0];
  const first = { ...s.audio };
  const chapterBefore = app.chapter("cliche", 1)!.duration;
  app.flagSegment("cliche", 1, s.id, "pronunciation", "reads “Ning” as two words");

  app.retakeSegment("cliche", 1, s.id);
  // while the retake is in flight the book is untouched: the clip still plays and still counts
  expect(s.audio).toMatchObject({ status: "done", duration: first.duration, at: first.at });
  expect(app.chapter("cliche", 1)!.duration).toBeCloseTo(chapterBefore, 10);
  // `_resume` dispatches straight away, so the candidate is already on its way out
  expect(["queued", "generating"]).toContain(s.candidate!.status);
  run();

  expect(s.audio).toMatchObject({ status: "done", duration: first.duration, at: first.at });
  expect(app.chapter("cliche", 1)!.duration).toBeCloseTo(chapterBefore, 10);
  expect(s.candidate).toMatchObject({ status: "done", n: 2 });
  expect(s.candidate!.duration).toBeGreaterThan(0);
  expect(s.audio.takes).toBeUndefined(); // nothing is history until a verdict
  expect(s.flag).toBeDefined(); // still flagged: the listener has not judged the new take yet

  const take2 = { ...s.candidate! };
  app.acceptTake("cliche", 1, s.id);
  expect(s.candidate).toBeUndefined();
  expect(s.audio).toMatchObject({ n: 2, duration: take2.duration, at: take2.at });
  expect(s.flag).toBeUndefined();
  expect(s.audio.takes).toHaveLength(1);
  expect(s.audio.takes![0].duration).toBe(first.duration);
  expect(app.chapter("cliche", 1)!.duration).toBeCloseTo(stitched("cliche", 1), 10);

  undos.pop()!();
  expect(s.audio.duration).toBe(first.duration);
  expect(s.candidate!.n).toBe(2);
  expect(s.flag?.kind).toBe("pronunciation");
});

test("dropping a retake leaves the kept clip exactly as it was, with its audit trail", () => {
  const s = narrated("cliche", 1)[1];
  const first = { ...s.audio };
  s.direction = "whispered"; // the retake is asked for *because* the direction changed
  app.retakeSegment("cliche", 1, s.id);
  run();
  const retakeDuration = s.candidate!.duration;

  app.rejectTake("cliche", 1, s.id);
  expect(s.candidate).toBeUndefined();
  expect(s.audio).toMatchObject({
    duration: first.duration,
    direction: first.direction,
    at: first.at,
    text: first.text,
  });
  expect(s.audio.said).toBe(first.said); // what was actually sent survives the rejection
  // the kept clip reads the old direction, so it is not pretending to be current
  expect(s.audio.status).toBe("stale");
  expect(s.audio.takes).toHaveLength(1);
  expect(s.audio.takes![0]).toMatchObject({ n: 2, rejected: true, duration: retakeDuration });
  expect(app.chapter("cliche", 1)!.duration).toBeCloseTo(stitched("cliche", 1), 10);

  undos.pop()!();
  expect(s.candidate!.n).toBe(2);
  expect(s.audio.status).toBe("done");
});

test("retaking the flagged segments runs them in one job and leaves the rest alone", () => {
  const [a, b, c] = narrated("cliche", 1);
  const untouched = { ...c.audio };
  app.flagSegment("cliche", 1, a.id, "pause", "");
  app.flagSegment("cliche", 1, b.id, "delivery", "flat");

  expect(app.retakeFlagged("cliche", 1)).toBe(2);
  expect(app.jobs.filter((j) => j.kind === "narration")).toHaveLength(1);
  run();

  expect(a.candidate).toMatchObject({ status: "done", n: 2 });
  expect(b.candidate).toMatchObject({ status: "done", n: 2 });
  expect(c.audio.at).toBe(untouched.at);
  expect(c.audio.takes).toBeUndefined();
  expect(app.chapter("cliche", 1)!.narration).toBe("done");
});

test("a plain retry keeps the take history and starts no comparison", () => {
  const s = narrated("cliche", 1)[0];
  app.retakeSegment("cliche", 1, s.id);
  run();
  app.acceptTake("cliche", 1, s.id);

  app.retrySegment("cliche", 1, s.id);
  run();
  expect(s.audio.takes).toHaveLength(1);
  expect(s.candidate).toBeUndefined();
});
