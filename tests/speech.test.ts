// Pronunciation dictionary and pacing: both change how a book sounds without changing a word of it.
//
// What the endpoint is sent is the server's to measure when a clip renders, and tested there; what
// is here is the rule itself and what the stores do with a change to it, against the demo's
// `cliche` read from a seeded demo library.
import { test, expect, beforeAll, beforeEach, describe } from "bun:test";

import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { speak, marks, silenceOf, DEFAULT_PACING, pauseAfter } from "@/lib/speech";
import type { LexEntry, Segment, ToastOptions } from "@/types";
import { demoServer } from "./support/demoServer";
import { openDemoBook } from "./support/demoBook";
import { testPinia } from "./support/pinia";

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
    expect(silenceOf(segs, DEFAULT_PACING, undefined)).toBeCloseTo(
      DEFAULT_PACING.line + DEFAULT_PACING.turn,
      10,
    );
  });

  test("a line's own pause wins, including none at all, and unrendered lines take no time", () => {
    const segs = [seg(1, "A", 0), seg(2, "B", 2), seg(3, "B")];
    expect(silenceOf(segs, DEFAULT_PACING, undefined)).toBeCloseTo(2, 10);
    // the middle line was never rendered, so its own 2s gap is not stitched and #1 runs straight
    // into #3 — exactly what plays back
    segs[1].audio.duration = 0;
    expect(silenceOf(segs, DEFAULT_PACING, undefined)).toBe(0);
  });
});

describe("in the store", () => {
  let undos: (() => unknown)[] = [];
  let castStore: ReturnType<typeof useCastStore>;
  let libraryStore: ReturnType<typeof useLibraryStore>;
  let narrationStore: ReturnType<typeof useNarrationStore>;
  let scriptsStore: ReturnType<typeof useScriptsStore>;

  beforeAll(async () => {
    Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
    await demoServer();
  });
  beforeEach(async () => {
    const pinia = testPinia();
    castStore = useCastStore();
    libraryStore = useLibraryStore();
    narrationStore = useNarrationStore();
    scriptsStore = useScriptsStore();
    const uiStore = useUiStore();
    undos = [];
    uiStore.toast = ((_msg: string, opts?: ToastOptions) => {
      if (opts?.undo) undos.push(opts.undo);
      return "test";
    }) as typeof uiStore.toast;
    await openDemoBook(pinia, "cliche");
  });

  /** the seeded “Ji Ning” entry and a rendered line that uses it */
  const withTerm = (bookId: string, chId: number) => {
    const s = scriptsStore
      .segmentsOf(bookId, chId)
      .find((x) => x.text.includes("Ji Ning") && x.audio.status === "done")!;
    expect(s).toBeDefined();
    return { s, id: castStore.lexiconOf(bookId).find((e) => e.term === "Ji Ning")!.id };
  };

  test("changing a term makes the clips that used the old spelling stale, and undo puts them back", async () => {
    const { s, id } = withTerm("cliche", 1);
    expect(s.audio.status).toBe("done");

    castStore.updateTerm("cliche", id, { say: "Gee Ning" });
    expect(s.audio.status).toBe("stale");
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("stale");

    await undos.pop()!();
    expect(s.audio.status).toBe("done");
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
    expect(castStore.lexiconOf("cliche").find((e) => e.id === id)!.say).toBe("Jee Ning");
  });

  test("a term nothing was rendered with leaves every clip alone", async () => {
    const before = scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status);
    castStore.addTerm("cliche", "zzyzx", "zizzix");
    expect(scriptsStore.segmentsOf("cliche", 1).map((s) => s.audio.status)).toEqual(before);
    expect(libraryStore.chapter("cliche", 1)!.narration).toBe("done");
    // the demo library is this file's, not this test's: the term goes again
    await undos.pop()!();
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

  test("the book's pacing re-times every chapter it has audio for", async () => {
    const narrated = libraryStore.chaptersOf("cliche").filter((c) => c.duration > 0);
    expect(narrated.length).toBeGreaterThan(0);
    const before = narrated.map((c) => c.duration);
    await castStore.setPacing("cliche", { line: 0, turn: 0 });
    // with no gaps at all a chapter is exactly the sum of its clips
    narrated.forEach((c, i) => {
      const held = libraryStore.chapter("cliche", c.id)!;
      expect(held.duration).toBeCloseTo(
        scriptsStore.segmentsOf("cliche", c.id).reduce((a, s) => a + s.audio.duration, 0),
        6,
      );
      expect(held.duration).toBeLessThan(before[i]);
    });
    await castStore.resetPacing("cliche");
    narrated.forEach((c, i) =>
      expect(libraryStore.chapter("cliche", c.id)!.duration).toBeCloseTo(before[i], 6),
    );
  });

  describe("the sample rate", () => {
    /** A rendered line on chapter 1, and the endpoint its speaker's voice is on now. */
    const rendered = () => {
      const s = scriptsStore.segmentsOf("cliche", 1).find((x) => x.audio.status === "done")!;
      const ep = castStore.effectiveVoice("cliche", s.speaker).endpoint!;
      expect(ep).toBeDefined();
      return { s, ep };
    };

    test("a clip rendered at one rate drifts when its endpoint now asks for another", () => {
      const { s, ep } = rendered();
      s.audio.sampleRate = 24000;
      ep.sampleRate = 48000;
      expect(narrationStore.clipDrift("cliche", s)).toContain("sample rate: 24 kHz → 48 kHz");
      ep.sampleRate = 44100;
      expect(narrationStore.clipDrift("cliche", s)).toContain("sample rate: 24 kHz → 44.1 kHz");
    });

    // an endpoint on the model's own rate asks for none; a clip that recorded none claims nothing
    test.each([
      { case: "the endpoint asks for no rate", clip: 24000, endpoint: null },
      { case: "the endpoint has no rate set at all", clip: 24000, endpoint: undefined },
      { case: "the clip recorded no rate", clip: undefined, endpoint: 48000 },
      { case: "the rates are the same", clip: 44100, endpoint: 44100 },
    ])("nothing drifts when $case", ({ clip, endpoint }) => {
      const { s, ep } = rendered();
      if (clip === undefined) delete s.audio.sampleRate;
      else s.audio.sampleRate = clip;
      if (endpoint === undefined) delete ep.sampleRate;
      else ep.sampleRate = endpoint;
      expect(narrationStore.clipDrift("cliche", s).join()).not.toContain("sample rate");
    });
  });
});
