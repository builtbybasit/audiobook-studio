// The app-wide player. A chapter is not a file: it is clips with stitched silence between them, so
// the queue, the gaps and the playhead are the player's own. The prototype has no rendered files, so
// every clip here is timed rather than heard — the same path real audio takes, minus the element.
// The clock and setInterval are faked, and each test drives the tick by hand.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { usePlayer, type Queue } from "@/composables/usePlayer";

const { p, play, playQueue, cue, pause, stop, seek, seekTo, skip, next, prev, setRate } =
  usePlayer();

let clock = 0;
let ticks = new Map<number, () => void>();
let restore: (() => void)[] = [];

/** let `seconds` of wall clock pass and run the player's tick once over it */
function advance(seconds: number): void {
  clock += seconds * 1000;
  const pending = [...ticks.values()]; // the tick may stop the player, which clears the map
  for (const fn of pending) fn();
}

/** two lines with a beat between them: 2s, 1s of silence, 3s */
const chapter = (id = "ch1", next?: () => Queue | null): Queue => ({
  id,
  title: id,
  clips: [
    { id: "a", duration: 2, gap: 1, speaker: "Narrator" },
    { id: "b", duration: 3 },
  ],
  next,
});

beforeEach(() => {
  clock = 0;
  ticks = new Map();
  let seq = 0;
  restore = [
    spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
      const id = ++seq;
      ticks.set(id, fn);
      return id;
    }) as unknown as typeof setInterval),
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      ticks.delete(id);
    }) as typeof clearInterval),
    spyOn(performance, "now").mockImplementation(() => clock),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => {
  stop();
  for (const r of restore) r();
});

describe("the timeline", () => {
  test("is the clips and the silence between them", () => {
    cue(chapter());
    expect(p.len).toBe(6); // 2 + 1 of silence + 3
    expect(p.clipId).toBe("a");
  });

  test("counts no clip in the silence after a line", () => {
    cue(chapter());
    seekTo(2.5); // inside the 1s gap
    expect(p.clipId).toBe(null);
    seekTo(3.5); // into the second line
    expect(p.clipId).toBe("b");
  });

  test("seek is a fraction of the whole queue, silence included", () => {
    cue(chapter());
    seek(0.5);
    expect(p.pos).toBe(3);
  });

  test("an audition carries no href, so nothing follows you off the page", () => {
    // the mini player keys off href: long-form playback has one, a few seconds of one line does not
    play("seg7", 3);
    expect(p.href).toBe(null);
    cue(chapter());
    expect(p.href).toBe(null);
    cue({ ...chapter(), href: "/book/b/narration?ch=1" });
    expect(p.href).toBe("/book/b/narration?ch=1");
  });

  test("a clip with no file is timed, not heard", () => {
    cue(chapter());
    expect(p.live).toBe(0);
    cue({ id: "real", clips: [{ id: "a", duration: 2, url: "/a.wav" }] });
    expect(p.live).toBe(1);
  });
});

describe("playing", () => {
  test("runs through a gap and into the next clip", () => {
    playQueue(chapter());
    expect(p.playing).toBe(true);
    advance(1);
    expect(p.clipId).toBe("a");
    advance(1.5); // 2.5s: past the end of the first line, inside its silence
    expect(p.clipId).toBe(null);
    advance(1); // 3.5s: the second line
    expect(p.clipId).toBe("b");
  });

  test("stops at the end when nothing follows", () => {
    playQueue(chapter());
    advance(10);
    expect(p.playing).toBe(false);
    expect(p.pos).toBe(p.len);
  });

  test("speed scales how fast the playhead moves", () => {
    playQueue(chapter());
    setRate(2);
    advance(1);
    expect(p.pos).toBe(2);
  });

  test("pressing the same chapter again toggles, a different one loads it", () => {
    playQueue(chapter("ch1"));
    playQueue(chapter("ch1")); // same queue: pause
    expect(p.playing).toBe(false);
    playQueue(chapter("ch2")); // another chapter: load and play it
    expect(p.id).toBe("ch2");
    expect(p.playing).toBe(true);
    expect(p.pos).toBe(0);
  });

  test("scrubbing a chapter that isn't loaded doesn't start it", () => {
    cue(chapter(), 4);
    expect(p.pos).toBe(4);
    expect(p.playing).toBe(false);
  });
});

describe("listening through a book", () => {
  test("a queue that runs out continues into the next one", () => {
    let handoffs = 0;
    playQueue(
      chapter("ch1", () => {
        handoffs++;
        return chapter("ch2");
      }),
    );
    advance(10);
    expect(handoffs).toBe(1);
    expect(p.id).toBe("ch2");
    expect(p.playing).toBe(true); // the chapter boundary is not a stop
    expect(p.pos).toBeLessThan(p.len);
  });

  test("and stops when there is no next chapter", () => {
    playQueue(chapter("last", () => null));
    advance(10);
    expect(p.id).toBe("last");
    expect(p.playing).toBe(false);
  });
});

describe("skipping", () => {
  test("next goes to the start of the following clip", () => {
    cue(chapter());
    next();
    expect(p.pos).toBe(3); // 2s of line + 1s of silence
    expect(p.clipId).toBe("b");
  });

  test("prev restarts the line, unless you only just started it", () => {
    cue(chapter());
    seekTo(5.5); // 2.5s into the second line — far enough in to mean "play it again"
    prev();
    expect(p.pos).toBe(3); // back to the top of it
    prev();
    expect(p.pos).toBe(0); // at the top already, so: the line before
    seekTo(4); // 1s into the second line — still the "wrong line" reflex
    prev();
    expect(p.pos).toBe(0);
  });

  test("skip is clamped to the queue", () => {
    cue(chapter());
    skip(-10);
    expect(p.pos).toBe(0);
    skip(100);
    expect(p.pos).toBe(6);
  });
});

test("pausing keeps the playhead where it is", () => {
  playQueue(chapter());
  advance(1.5);
  pause();
  const at = p.pos;
  advance(5); // the clock moves on; the player does not
  expect(p.playing).toBe(false);
  expect(p.pos).toBe(at);
});
