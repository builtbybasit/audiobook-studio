// One process-wide gate on how many lines are out at each speech endpoint. A line waits while its
// endpoint is paused (held, not failed), cooling down after a rate limit, or at its `concurrency`;
// each endpoint's lines go out in the order they asked. Limits are read on every look, so a change
// applies live. `live` is in-memory telemetry for the Endpoints page.
import type { EndpointLive } from "@/types";

/** undefined when the endpoint is not configured. */
export interface GateLimits {
  concurrency: number;
  enabled: boolean;
}

export type GateWait = "paused" | "cooldown" | "concurrency";

export interface AcquireOptions {
  /** a cancel takes the line out of the wait, rejecting with its reason */
  signal: AbortSignal;
  /** told when the head of the line's reason for waiting changes */
  waiting?(why: GateWait): void;
}

export interface SpeechGate {
  /**
   * Resolves to the slot's release, safe to call twice. `id` null (no endpoint) goes one at a time,
   * never paused or cooled; the provider will refuse it anyway.
   */
  acquire(
    id: string | null,
    limits: () => GateLimits | undefined,
    options: AcquireOptions,
  ): Promise<() => void>;
  /** Holds every line for `id` for `waitMs`. */
  rateLimited(id: string, waitMs: number): void;
  /** The configuration was saved: look again. */
  changed(): void;
  /** Forget rate limits and cooldowns (the demo was reseeded); lines out and waiting are kept. */
  forget(): void;
  live(): Record<string, EndpointLive>;
}

/** Polls while a paused endpoint holds work, for a change that bypassed `changed`. */
export const PAUSED_POLL_MS = 1000;

const NOWHERE = "";

interface Waiter {
  limits: () => GateLimits | undefined;
  options: AcquireOptions;
  resolve(release: () => void): void;
  reject(reason: unknown): void;
  /** last reason told, so it is told only on a change */
  told: GateWait | null;
}

interface State extends EndpointLive {
  queue: Waiter[];
  /** wakes the endpoint when its cooldown ends */
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
    // not configured: hold nothing, the provider refuses the line at once
    if (!limits) return s.active >= 1 ? "concurrency" : null;
    if (!limits.enabled) return "paused";
    if (s.backoffUntil > now()) return "cooldown";
    if (s.active >= Math.max(1, limits.concurrency)) return "concurrency";
    return null;
  }

  /**
   * A failed read counts as not configured: it runs inside whatever woke the gate, where a throw
   * would land in someone else's hands.
   */
  function limitsOf(w: Waiter): GateLimits | undefined {
    try {
      return w.limits();
    } catch {
      return undefined;
    }
  }

  function wake(id: string, s: State): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const ms = Math.max(0, s.backoffUntil - now());
    // Armed even at 0 if a line waits: `pump` just saw it cooling; with no timer it would hang.
    if (ms === 0 && !s.queue.length) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      pump(id);
    }, ms);
    (s.timer as { unref?(): void }).unref?.();
  }

  function pump(id: string): void {
    const s = states.get(id);
    if (!s) return;
    while (s.queue.length) {
      const head = s.queue[0];
      const why = blockedBy(s, id === NOWHERE ? undefined : limitsOf(head));
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
    for (const id of states.keys()) pump(id);
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
          // the line behind may go now, or need telling why not
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
      // tell the head it now waits on the cooldown
      pump(id);
    },

    changed: pumpAll,

    forget() {
      for (const s of states.values()) {
        if (s.timer) clearTimeout(s.timer);
        s.timer = null;
        s.rateLimits = 0;
        s.backoffUntil = 0;
      }
      pumpAll();
    },

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
