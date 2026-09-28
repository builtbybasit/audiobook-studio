// The speech gate on its own: when a line may go out to its endpoint — fewer than its concurrency
// out, not paused, not cooling down after a rate limit — in the order the lines asked, and what it
// tells the line at the head about why it waits. The limits are a callback here, as the narration
// job's reading of the endpoints table is, so a test changes them the way a save on the Endpoints
// page does: in place, then `changed()` — or not, for the poll that is there for exactly that.
//
// The gate's timers are real, so the waits here are tens of milliseconds; where a test is about a
// moment rather than a wait, the gate is handed a clock the test moves itself. The one wait that is
// a second long — the paused poll — runs on Bun's fake timers.
import { afterEach, describe, expect, jest, test } from "bun:test";

import {
  createSpeechGate,
  PAUSED_POLL_MS,
  type GateLimits,
  type GateWait,
  type SpeechGate,
} from "~/providers/gate";

/** An endpoint's limits as the table holds them, changed in place the way a save changes them. */
function endpoint(concurrency = 1, enabled = true) {
  const at: { now: GateLimits | undefined } = { now: { concurrency, enabled } };
  return {
    limits: () => at.now,
    set(over: Partial<GateLimits>) {
      at.now = { ...at.now!, ...over };
    },
    remove() {
      at.now = undefined;
    },
  };
}

/** One line asking the gate: whether it is out yet, what it was told, and how to cancel it. */
interface Asked {
  readonly out: boolean;
  readonly error: unknown;
  told: GateWait[];
  release(): void;
  cancel(reason?: unknown): void;
}

function ask(
  gate: SpeechGate,
  id: string | null,
  limits: () => GateLimits | undefined,
  signal?: AbortSignal,
): Asked {
  const ctl = new AbortController();
  const told: GateWait[] = [];
  let out = false;
  let error: unknown;
  let release: (() => void) | undefined;
  gate
    .acquire(id, limits, { signal: signal ?? ctl.signal, waiting: (why) => void told.push(why) })
    .then(
      (r) => {
        out = true;
        release = r;
      },
      (e) => void (error = e),
    );
  return {
    get out() {
      return out;
    },
    get error() {
      return error;
    },
    told,
    release() {
      if (!release) throw new Error("released a line that never went out");
      release();
    },
    cancel: (reason = new Error("cancelled by you")) => ctl.abort(reason),
  };
}

/** Let every promise that can settle, settle — one turn of the event loop. */
const settle = () => new Promise<void>((r) => setImmediate(r));
/** Wait `ms` of real time, and the settling after it. */
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)).then(settle);
const outOf = (lines: Asked[]) => lines.map((l) => l.out);

describe("a line at the gate", () => {
  test("goes out while fewer than the endpoint's concurrency are out, and the next waits for a release", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(2);
    const lines = [1, 2, 3].map(() => ask(gate, "studio", studio.limits));
    await settle();
    expect(outOf(lines)).toEqual([true, true, false]);
    expect(gate.live()).toEqual({
      studio: { active: 2, waiting: 1, rateLimits: 0, backoffUntil: 0 },
    });

    lines[0].release();
    await settle();
    expect(outOf(lines)).toEqual([true, true, true]);
    expect(gate.live().studio).toMatchObject({ active: 2, waiting: 0 });
  });

  test("the lines for one endpoint go out in the order they asked", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(1);
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const ctl = new AbortController();
    for (const n of [1, 2, 3, 4, 5])
      void gate.acquire("studio", studio.limits, { signal: ctl.signal }).then((release) => {
        order.push(n);
        releases.push(release);
      });
    // one out at a time, each let out by the release of the one before it
    for (let i = 0; i < 5; i++) {
      await settle();
      expect(order).toHaveLength(i + 1);
      releases[i]();
    }
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  test("a full endpoint does not hold another endpoint's lines", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(1);
    const other = endpoint(1);
    const first = ask(gate, "studio", studio.limits);
    const held = ask(gate, "studio", studio.limits);
    const elsewhere = ask(gate, "other", other.limits);
    await settle();
    expect(outOf([first, held, elsewhere])).toEqual([true, false, true]);
    expect(gate.live()).toEqual({
      studio: { active: 1, waiting: 1, rateLimits: 0, backoffUntil: 0 },
      other: { active: 1, waiting: 0, rateLimits: 0, backoffUntil: 0 },
    });
  });

  test("a line with no endpoint goes one at a time, is never held by a pause, and is not shown live", async () => {
    const gate = createSpeechGate();
    // what its limits say is never read: there is no endpoint for it to be paused on
    const paused = endpoint(5, false);
    const lines = [1, 2].map(() => ask(gate, null, paused.limits));
    await settle();
    expect(outOf(lines)).toEqual([true, false]);
    expect(lines[1].told).toEqual(["concurrency"]);
    lines[0].release();
    await settle();
    expect(lines[1].out).toBe(true);
    expect(gate.live()).toEqual({});
  });

  test("an endpoint removed from the table lets one line through at a time, for the provider to refuse", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(3);
    studio.remove();
    const lines = [1, 2].map(() => ask(gate, "studio", studio.limits));
    await settle();
    expect(outOf(lines)).toEqual([true, false]);
  });

  test("a release is safe to call twice: the second frees no one else's slot", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(1);
    const lines = [1, 2, 3].map(() => ask(gate, "studio", studio.limits));
    await settle();
    lines[0].release();
    lines[0].release();
    await settle();
    expect(outOf(lines)).toEqual([true, true, false]);
    expect(gate.live().studio).toMatchObject({ active: 1, waiting: 1 });
  });
});

describe("limits read live", () => {
  test("a concurrency raised mid-run lets the waiting lines out once the gate is told", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(1);
    const lines = [1, 2, 3].map(() => ask(gate, "studio", studio.limits));
    await settle();
    studio.set({ concurrency: 3 });
    await settle();
    // the gate looks when it is told, or when a line comes back — not on its own
    expect(outOf(lines)).toEqual([true, false, false]);
    gate.changed();
    await settle();
    expect(outOf(lines)).toEqual([true, true, true]);
  });

  test("a concurrency lowered takes nothing back from the lines already out", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(3);
    const out = [1, 2, 3].map(() => ask(gate, "studio", studio.limits));
    await settle();
    studio.set({ concurrency: 1 });
    gate.changed();
    const next = ask(gate, "studio", studio.limits);
    await settle();
    expect(outOf(out)).toEqual([true, true, true]);
    expect(gate.live().studio).toMatchObject({ active: 3, waiting: 1 });
    // it waits until fewer than the new concurrency are out, not the old
    out[0].release();
    out[1].release();
    await settle();
    expect(next.out).toBe(false);
    out[2].release();
    await settle();
    expect(next.out).toBe(true);
  });

  test("a paused endpoint holds its lines rather than failing them, and a resume told to the gate lets them out", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(2);
    const already = ask(gate, "studio", studio.limits);
    await settle();
    studio.set({ enabled: false });
    gate.changed();
    const held = ask(gate, "studio", studio.limits);
    await settle();
    expect(held.out).toBe(false);
    expect(held.error).toBeUndefined();
    expect(held.told).toEqual(["paused"]);
    // a pause stops what goes out next; the line already out keeps its slot
    expect(already.out).toBe(true);
    expect(gate.live().studio).toMatchObject({ active: 1, waiting: 1 });

    studio.set({ enabled: true });
    gate.changed();
    await settle();
    expect(held.out).toBe(true);
    already.release();
    held.release();
  });

  test("a resume that reaches the table without the gate being told is found by its own poll", async () => {
    jest.useFakeTimers();
    try {
      const gate = createSpeechGate();
      const studio = endpoint(1, false);
      const held = ask(gate, "studio", studio.limits);
      await Promise.resolve();
      studio.set({ enabled: true });
      jest.advanceTimersByTime(PAUSED_POLL_MS - 1);
      await Promise.resolve();
      expect(held.out).toBe(false);
      jest.advanceTimersByTime(1);
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(held.out).toBe(true);
      held.release();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("a rate limit", () => {
  afterEach(() => jest.useRealTimers());

  test("holds new lines until the cooldown ends, and counts itself", async () => {
    let now = 1_000;
    const gate = createSpeechGate(() => now);
    const studio = endpoint(4);
    const already = ask(gate, "studio", studio.limits);
    await settle();
    gate.rateLimited("studio", 5_000);
    const held = ask(gate, "studio", studio.limits);
    await settle();
    expect(held.out).toBe(false);
    expect(held.told).toEqual(["cooldown"]);
    expect(gate.live().studio).toEqual({
      active: 1,
      waiting: 1,
      rateLimits: 1,
      backoffUntil: 6_000,
    });
    // the line that met it is not taken back: it waits out the same cooldown in `call`
    expect(already.out).toBe(true);

    now = 5_999;
    gate.changed();
    await settle();
    expect(held.out).toBe(false);
    now = 6_000;
    gate.changed();
    await settle();
    expect(held.out).toBe(true);
  });

  test("lets the held lines out on its own timer when the cooldown ends", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(2);
    gate.rateLimited("studio", 30);
    const held = [1, 2].map(() => ask(gate, "studio", studio.limits));
    await settle();
    expect(outOf(held)).toEqual([false, false]);
    await pause(60);
    expect(outOf(held)).toEqual([true, true]);
  });

  test("a later one extends the cooldown and never shortens it", () => {
    let now = 1_000;
    const gate = createSpeechGate(() => now);
    gate.rateLimited("studio", 500);
    expect(gate.live().studio.backoffUntil).toBe(1_500);
    now = 1_100;
    gate.rateLimited("studio", 100);
    expect(gate.live().studio.backoffUntil).toBe(1_500);
    gate.rateLimited("studio", 700);
    expect(gate.live().studio.backoffUntil).toBe(1_800);
    // a wait of nothing — a Retry-After of 0 — is still a rate limit the endpoint answered with
    gate.rateLimited("studio", 0);
    expect(gate.live().studio).toEqual({
      active: 0,
      waiting: 0,
      rateLimits: 4,
      backoffUntil: 1_800,
    });
  });

  test("a cooldown that ends between two looks at the clock still lets the line out", async () => {
    // The gate reads the clock once to find the endpoint cooling down and again to time the
    // wake-up; a tick over the end between the two must not leave the line with no timer at all.
    const reads: number[] = [];
    let now = 1_000;
    const gate = createSpeechGate(() => reads.shift() ?? now);
    const studio = endpoint(1);
    gate.rateLimited("studio", 50);
    reads.push(1_049, 1_050);
    now = 1_050;
    const held = ask(gate, "studio", studio.limits);
    await settle();
    expect(held.told).toEqual(["cooldown"]);
    await pause(80);
    expect(held.out).toBe(true);
  });

  test("does not hold another endpoint's lines", async () => {
    const gate = createSpeechGate();
    gate.rateLimited("studio", 60_000);
    const elsewhere = ask(gate, "other", endpoint(1).limits);
    await settle();
    expect(elsewhere.out).toBe(true);
  });
});

describe("the line at the head", () => {
  test("is told why it waits once per change of reason, and the lines behind it are told nothing", async () => {
    let now = 1_000;
    const gate = createSpeechGate(() => now);
    const studio = endpoint(1);
    const first = ask(gate, "studio", studio.limits);
    const head = ask(gate, "studio", studio.limits);
    const behind = ask(gate, "studio", studio.limits);
    await settle();
    expect(head.told).toEqual(["concurrency"]);
    // looking again for the same reason tells it nothing new
    gate.changed();
    await settle();
    expect(head.told).toEqual(["concurrency"]);

    studio.set({ enabled: false });
    gate.changed();
    studio.set({ enabled: true });
    gate.rateLimited("studio", 1_000);
    gate.changed();
    now = 2_000;
    gate.changed();
    await settle();
    expect(head.told).toEqual(["concurrency", "paused", "cooldown", "concurrency"]);
    expect(behind.told).toEqual([]);

    // once it goes, the line behind it is at the head and is told in its turn
    first.release();
    await settle();
    expect(head.out).toBe(true);
    expect(behind.told).toEqual(["concurrency"]);
  });
});

describe("a cancel", () => {
  test("while waiting rejects with the job's reason, and the line behind takes its place", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(1);
    const first = ask(gate, "studio", studio.limits);
    const cancelled = ask(gate, "studio", studio.limits);
    const behind = ask(gate, "studio", studio.limits);
    await settle();
    const reason = new Error("cancelled by you");
    cancelled.cancel(reason);
    await settle();
    expect(cancelled.error).toBe(reason);
    expect(behind.told).toEqual(["concurrency"]);
    expect(gate.live().studio).toMatchObject({ active: 1, waiting: 1 });

    first.release();
    await settle();
    expect(cancelled.out).toBe(false);
    expect(behind.out).toBe(true);
  });

  test("of a line held by a pause stops the poll that was watching for the resume", async () => {
    jest.useFakeTimers();
    try {
      const gate = createSpeechGate();
      const studio = endpoint(1, false);
      const held = ask(gate, "studio", studio.limits);
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1);
      held.cancel();
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("before asking is refused at once, and takes no slot", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(1);
    const ctl = new AbortController();
    const reason = new Error("cancelled by you");
    ctl.abort(reason);
    const refused = ask(gate, "studio", studio.limits, ctl.signal);
    const next = ask(gate, "studio", studio.limits);
    await settle();
    expect(refused.error).toBe(reason);
    expect(next.out).toBe(true);
  });

  test("after the line went out leaves its slot to its release", async () => {
    const gate = createSpeechGate();
    const studio = endpoint(1);
    const line = ask(gate, "studio", studio.limits);
    const next = ask(gate, "studio", studio.limits);
    await settle();
    line.cancel();
    await settle();
    expect(line.error).toBeUndefined();
    expect(next.out).toBe(false);
    line.release();
    await settle();
    expect(next.out).toBe(true);
  });
});
