// How many lines are out at one speech endpoint at once, and when none may go at all.
//
// The demo's dispatch rule, kept on the server: a line goes to the endpoint its speaker's voice
// belongs to when that endpoint is enabled, is not cooling down after a rate limit, and has fewer
// lines out than its `concurrency`. Otherwise it waits — a paused endpoint *holds* its work rather
// than failing it, which is what separates Pause from Cancel — and the lines for one endpoint go
// out in the order they asked, so a chapter still renders front to back on each endpoint.
//
// One gate for the whole process, not one per job, because the limit is the provider's: two runs
// against the same key share its ceiling whether or not the queue ever runs them side by side. The
// limits are read through a callback every time the gate looks, not handed over once, so a person
// who raises the concurrency or pauses the endpoint mid-run changes what the next line does — the
// Endpoints page says both apply live. The gate is told when the configuration is saved
// (`changed`), and looks again on its own every so often while a paused endpoint holds work, so a
// change that reached the table some other way is not missed for long.
//
// A rate limit is the endpoint's, not the request's: the request that met it waits and tries again
// as it always has (`http.ts`), and the gate holds every other line for that endpoint until the
// same moment (`rateLimited`), so the lines behind it do not walk into the same refusal one by
// one. What the gate has seen — lines out and waiting, rate limits, the cooldown's end — is this
// process's telemetry (`live`), which the Endpoints page reads; none of it is stored.
import type { EndpointLive } from "@/types";

/** What the gate reads about an endpoint each time it looks; undefined when it is not configured. */
export interface GateLimits {
  concurrency: number;
  enabled: boolean;
}

/** Why a line is not going out yet. */
export type GateWait = "paused" | "cooldown" | "concurrency";

export interface AcquireOptions {
  /** the job's signal: a cancel takes the line out of the wait, rejecting with its reason */
  signal: AbortSignal;
  /** told each time the reason this line is waiting changes, while it is first in line */
  waiting?(why: GateWait): void;
}

export interface SpeechGate {
  /**
   * Wait until the endpoint will take one more line, and hold its slot: resolves to the release,
   * which is safe to call more than once. `id` null is a line with no endpoint to go to, which goes
   * one at a time and is never paused or cooled — the provider will refuse it anyway.
   */
  acquire(
    id: string | null,
    limits: () => GateLimits | undefined,
    options: AcquireOptions,
  ): Promise<() => void>;
  /** A request to `id` was refused as rate limited and will wait `waitMs`; so does every other. */
  rateLimited(id: string, waitMs: number): void;
  /** The configuration was saved: look again at every endpoint something is waiting on. */
  changed(): void;
  /** What this process has seen of each endpoint it has sent to; see the header. */
  live(): Record<string, EndpointLive>;
}

/** How often a gate with work held by a paused endpoint looks again without being told. */
export const PAUSED_POLL_MS = 1000;

/** The key a line with no endpoint waits under. */
const NOWHERE = "";

interface Waiter {
  limits: () => GateLimits | undefined;
  options: AcquireOptions;
  resolve(release: () => void): void;
  reject(reason: unknown): void;
  /** the reason it was last told, so it is told only when that changes */
  told: GateWait | null;
}

interface State extends EndpointLive {
  queue: Waiter[];
  /** the timer that wakes this endpoint when its cooldown ends */
  timer: ReturnType<typeof setTimeout> | null;
}

export function createSpeechGate(now: () => number = Date.now): SpeechGate {
  const states = new Map<string, State>();
  let poll: ReturnType<typeof setInterval> | null = null;

  const stateOf = (id: string): State => {
    let s = states.get(id);
    if (!s) {
      s = { active: 0, waiting: 0, rateLimits: 0, backoffUntil: 0, queue: [], timer: null };
      states.set(id, s);
    }
    return s;
  };

  function blockedBy(s: State, limits: GateLimits | undefined): GateWait | null {
    // an endpoint that is not configured holds nothing: the provider refuses the line at once
    if (!limits) return s.active >= 1 ? "concurrency" : null;
    if (!limits.enabled) return "paused";
    if (s.backoffUntil > now()) return "cooldown";
    if (s.active >= Math.max(1, limits.concurrency)) return "concurrency";
    return null;
  }

  function wake(id: string, s: State): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const ms = s.backoffUntil - now();
    if (ms <= 0) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      pump(id);
    }, ms);
    (s.timer as { unref?(): void }).unref?.();
  }

  /** Let out every line the endpoint will now take, first come first served. */
  function pump(id: string): void {
    const s = states.get(id);
    if (!s) return;
    while (s.queue.length) {
      const head = s.queue[0];
      const why = blockedBy(s, id === NOWHERE ? undefined : head.limits());
      if (why) {
        if (why !== head.told) {
          head.told = why;
          head.options.waiting?.(why);
        }
        if (why === "cooldown") wake(id, s);
        break;
      }
      s.queue.shift();
      s.waiting = s.queue.length;
      s.active++;
      let released = false;
      head.resolve(() => {
        if (released) return;
        released = true;
        s.active--;
        pump(id);
      });
    }
    s.waiting = s.queue.length;
    watchPaused();
  }

  /** Keep looking while something waits on a pause; stop once nothing does. */
  function watchPaused(): void {
    const held = [...states.values()].some((s) => s.queue[0]?.told === "paused");
    if (held && !poll) {
      poll = setInterval(pumpAll, PAUSED_POLL_MS);
      (poll as { unref?(): void }).unref?.();
    } else if (!held && poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  function pumpAll(): void {
    for (const id of [...states.keys()]) pump(id);
  }

  return {
    acquire(id, limits, options) {
      const { signal } = options;
      if (signal.aborted) return Promise.reject(signal.reason);
      const key = id ?? NOWHERE;
      const s = stateOf(key);
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = {
          limits,
          options,
          told: null,
          resolve(release) {
            signal.removeEventListener("abort", onAbort);
            resolve(release);
          },
          reject,
        };
        function onAbort(): void {
          const at = s.queue.indexOf(waiter);
          if (at < 0) return;
          s.queue.splice(at, 1);
          reject(signal.reason);
          // the line behind it may be free to go, or may now be first and need telling why not
          pump(key);
        }
        signal.addEventListener("abort", onAbort, { once: true });
        s.queue.push(waiter);
        pump(key);
      });
    },

    rateLimited(id, waitMs) {
      const s = stateOf(id);
      s.rateLimits++;
      s.backoffUntil = Math.max(s.backoffUntil, now() + Math.max(0, waitMs));
      wake(id, s);
    },

    changed: pumpAll,

    live() {
      const out: Record<string, EndpointLive> = {};
      for (const [id, s] of states)
        if (id !== NOWHERE)
          out[id] = {
            active: s.active,
            waiting: s.waiting,
            rateLimits: s.rateLimits,
            backoffUntil: s.backoffUntil,
          };
      return out;
    },
  };
}
