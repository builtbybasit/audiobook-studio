import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// Pronunciation dictionary and pacing: both change how a book sounds without changing a word of it.
// The store's narration simulation runs on setTimeout, so the clock and both timer APIs are faked.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { speak, marks, silenceOf, DEFAULT_PACING, pauseAfter } from "@/lib/speech";
import type { LexEntry, Segment, ToastOptions } from "@/types";

const entry = (term: string, say: string, extra: Partial<LexEntry> = {}): LexEntry => ({
  id: 1,
  term,
  say,
  enabled: true,
  ...extra,
});

describe("the dictionary", () => {
  test("rewrites whole words only, in any capitalisation", () => {
    const list = [entry("Ning", "Neeng")];
    expect(speak("Ning waited.", list).text).toBe("Neeng waited.");
    expect(speak("ning waited.", list).text).toBe("Neeng waited.");
    expect(speak("Ninghai waited.", list).text).toBe("Ninghai waited."); // inside a longer word
    expect(speak("“Ning!” she said.", list).text).toBe("“Neeng!” she said.");
  });

  test("prefers the longest term and never re-matches its own replacement", () => {
    const list = [entry("Ji Ning", "Jee Ning"), entry("Ning", "Neeng", { id: 2 })];
    // "Ji Ning" wins over "Ning" at the same spot, and the "Ning" it produces is left alone
    expect(speak("Ji Ning and Ning.", list).text).toBe("Jee Ning and Neeng.");
  });

  test("respects match-case and the on/off switch", () => {
    expect(speak("Qi flows; qi rests.", [entry("Qi", "chee", { matchCase: true })]).text).toBe(
      "chee flows; qi rests.",
    );
    expect(speak("Qi flows.", [entry("Qi", "chee", { enabled: false })]).text).toBe("Qi flows.");
    expect(speak("Qi flows.", [entry("Qi", "  ")]).text).toBe("Qi flows."); // nothing to say
  });

  test("marks the original text without altering it", () => {
    const out = marks("Ji Ning bowed.", [entry("Ji Ning", "Jee Ning")]);
    expect(out).toEqual([{ text: "Ji Ning", say: "Jee Ning" }, { text: " bowed." }]);
    expect(out.map((m) => m.text).join("")).toBe("Ji Ning bowed.");
  });
});

describe("pacing", () => {
  const seg = (id: number, speaker: string, pause?: number): Segment =>
    ({
      id,
      speaker,
      type: "dialogue",
      text: "x",
      direction: "",
      ...(pause == null ? {} : { pause }),
      audio: { status: "done", endpoint: null, ms: 0, duration: 1 },
    }) as Segment;

  test("holds longer when the voice changes, and not at all after the last clip", () => {
    const segs = [seg(1, "A"), seg(2, "A"), seg(3, "B")];
    expect(pauseAfter(segs[0], segs[1], DEFAULT_PACING)).toBe(DEFAULT_PACING.line);
    expect(pauseAfter(segs[1], segs[2], DEFAULT_PACING)).toBe(DEFAULT_PACING.turn);
    expect(pauseAfter(segs[2], undefined, DEFAULT_PACING)).toBe(0);
    expect(silenceOf(segs, DEFAULT_PACING)).toBeCloseTo(
      DEFAULT_PACING.line + DEFAULT_PACING.turn,
      10,
    );
  });

  test("a line's own pause wins, including none at all, and unrendered lines take no time", () => {
    const segs = [seg(1, "A", 0), seg(2, "B", 2), seg(3, "B")];
    expect(silenceOf(segs, DEFAULT_PACING)).toBeCloseTo(2, 10);
    // the middle line was never rendered, so its own 2s gap is not stitched and #1 runs straight
    // into #3 — exactly what plays back
    segs[1].audio.duration = 0;
    expect(silenceOf(segs, DEFAULT_PACING)).toBe(0);
  });
});

describe("in the store", () => {
  let timers = new Map<number, () => void>();
  let clock = 1000;
  let restore: (() => void)[] = [];
  let undos: (() => void)[] = [];
  let castStore: ReturnType<typeof useCastStore>;
  let endpointsStore: ReturnType<typeof useEndpointsStore>;
  let jobsStore: ReturnType<typeof useJobsStore>;
  let libraryStore: ReturnType<typeof useLibraryStore>;
  let narrationStore: ReturnType<typeof useNarrationStore>;
  let scriptsStore: ReturnType<typeof useScriptsStore>;
  let uiStore: ReturnType<typeof useUiStore>;

  function run(rounds = 400): void {
    for (let i = 0; i < rounds && timers.size; i++) {
      clock += 500;
      const pending = [...timers];
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
    castStore = useCastStore();
    endpointsStore = useEndpointsStore();
    jobsStore = useJobsStore();
    libraryStore = useLibraryStore();
    narrationStore = useNarrationStore();
    scriptsStore = useScriptsStore();
    uiStore = useUiStore();
    jobsStore.jobs = [];
    undos = [];
    uiStore.toast = ((_msg: string, opts?: ToastOptions) => {
      if (opts?.undo) undos.push(opts.undo);
      return "test";
    }) as typeof uiStore.toast;
    for (const e of endpointsStore.endpoints) {
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

  /** the seeded “Ji Ning” entry and a rendered line that uses it */
  const withTerm = (bookId: string, chId: number) => {
    const s = scriptsStore
      .segmentsOf(bookId, chId)
      .find((x) => x.text.includes("Ji Ning") && x.audio.status === "done")!;
    expect(s).toBeDefined();
    return { s, id: castStore.lexiconOf(bookId).find((e) => e.term === "Ji Ning")!.id };
  };

  test("the endpoint is sent the respelling; the book keeps its own spelling", () => {
    const { s } = withTerm("cliche", 1);
    narrationStore.retrySegment("cliche", 1, s.id);
    run();
    expect(s.text).toContain("Ji Ning"); // the script is never rewritten
    expect(s.audio.said).toContain("Jee Ning");
    expect(s.audio.said).not.toContain("Ji Ning");
    expect(s.audio.text).toBe(s.text);
    expect(s.audio.lex).toBeGreaterThan(0);
  });

  test("changing a term makes the clips that used the old spelling stale, and undo puts them back", () => {
    const { s, id } = withTerm("cliche", 1);
    expect(s.audio.status).toBe("done");

    castStore.updateTerm("cliche", id, { say: "Gee Ning" });
    expect(s.audio.status).toBe("stale");
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");

    undos.pop()!();
    expect(s.audio.status).toBe("done");
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
    expect(castStore.lexiconOf("cliche").find((e) => e.id === id)!.say).toBe("Jee Ning");
  });

  test("a term nothing was rendered with leaves every clip alone", () => {
    const before = scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status);
    castStore.addTerm("cliche", "zzyzx", "zizzix");
    expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status)).toEqual(before);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
  });

  test("re-narrating after a dictionary change sends the new spelling", () => {
    const { s, id } = withTerm("cliche", 1);
    castStore.updateTerm("cliche", id, { say: "Gee Ning" });
    narrationStore.renarrateStale("cliche", 1);
    run();
    expect(s.audio.status).toBe("done");
    expect(s.audio.said).toContain("Gee Ning");
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
  });

  test("switching a term off restores the plain spelling on the next render", () => {
    const { s, id } = withTerm("cliche", 1);
    castStore.updateTerm("cliche", id, { enabled: false });
    narrationStore.retrySegment("cliche", 1, s.id);
    run();
    // other entries may still apply to this line; this one no longer does
    expect(s.audio.said ?? s.audio.text).toContain("Ji Ning");
    expect(s.audio.said ?? "").not.toContain("Jee Ning");
    expect(s.audio.text).toBe(s.text);
  });

  test("a term edited mid-render lands the finished clip stale, not done", () => {
    const { s, id } = withTerm("cliche", 1);
    narrationStore.retrySegment("cliche", 1, s.id);
    // the request is in flight; the dictionary moves under it before the clip comes back
    expect(s.audio.status).toBe("generating");
    castStore.updateTerm("cliche", id, { say: "Gee Ning" });
    run();

    expect(s.audio.said).toContain("Jee Ning"); // what was actually sent
    expect(s.audio.status).toBe("stale"); // …and it is no longer what the dictionary says
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");
    expect(narrationStore.clipDrift("cliche", s)).toContain(
      "pronunciation: the dictionary changed after this clip",
    );
  });

  test("an edit mid-render is caught the same way", () => {
    const s = scriptsStore.segmentsOf("cliche", 1).find((x) => x.audio.status === "done")!;
    narrationStore.retrySegment("cliche", 1, s.id);
    expect(s.audio.status).toBe("generating");
    s.text = s.text + " And then silence.";
    run();
    expect(s.audio.status).toBe("stale");
  });

  test("a pause re-times the chapter without invalidating any audio", () => {
    const segs = scriptsStore.segmentsOf("cliche", 1);
    const before = libraryStore.chapter("cliche", 1)!.duration;
    const statuses = segs.map((s) => s.audio.status);

    castStore.setPause("cliche", 1, segs[0].id, 2.5);
    const added = 2.5 - pauseAfter({ ...segs[0], pause: undefined }, segs[1], DEFAULT_PACING);
    expect(libraryStore.chapter("cliche", 1)!.duration).toBeCloseTo(before + added, 10);
    expect(segs.map((s) => s.audio.status)).toEqual(statuses);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");

    castStore.setPause("cliche", 1, segs[0].id, null);
    expect(libraryStore.chapter("cliche", 1)!.duration).toBeCloseTo(before, 10);
  });

  test("the book's pacing re-times every chapter it has audio for", () => {
    const narrated = libraryStore.chaptersOf("cliche").filter((c) => c.duration > 0);
    const before = narrated.map((c) => c.duration);
    castStore.setPacing("cliche", { line: 0, turn: 0 });
    // with no gaps at all a chapter is exactly the sum of its clips
    narrated.forEach((c, i) => {
      expect(c.duration).toBeCloseTo(
        scriptsStore.segmentsOf("cliche", c.id).reduce((a, s) => a + s.audio.duration, 0),
        10,
      );
      expect(c.duration).toBeLessThan(before[i]);
    });
    castStore.resetPacing("cliche");
    narrated.forEach((c, i) => expect(c.duration).toBeCloseTo(before[i], 10));
  });
});
