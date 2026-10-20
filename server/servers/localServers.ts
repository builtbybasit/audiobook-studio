// Servers on this machine the app starts and stops: one process each, keyed by `serverKey`. A
// request to an endpoint with `launch` waits here until its server answers. Heavy servers take
// the GPU, so starting one first stops the heavy one running, once nothing has used it for
// `SETTLE_MS`: a chapter's lines for one server all go before the switch. Process-wide, since
// processes and VRAM are.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { LocalServerState, LocalServerStatus } from "@/types";
import { DEFAULT_READY_SEC } from "@/lib/localServers";
import { env } from "~/env";
import { sleep } from "~/providers/fake";
import { ProviderError } from "~/providers/http";
import type { LaunchTarget } from "~/providers/target";

/** What a server needs to be started and checked; `ProviderTarget` satisfies it. */
export interface Launchable {
  /** for messages */
  name: string;
  /** asked until anything answers, even a 404 */
  baseUrl: string;
  localServer: LaunchTarget;
}

export interface LocalServers {
  /**
   * Starts the server if needed and resolves once it answers, with a release to call when the
   * request is over (safe twice). Throws a non-retryable `ProviderError` when it can't start, and
   * the signal's reason on a cancel.
   */
  use(target: Launchable, signal: AbortSignal): Promise<() => void>;
  /** The Start button: like `use` with no request, and clears a failed start. */
  start(target: Launchable): Promise<void>;
  /** The Stop button: SIGTERM to its process group, SIGKILL after `KILL_AFTER_MS`. */
  stop(key: string): Promise<void>;
  status(): Record<string, LocalServerStatus>;
  /** Every server this app started, on shutdown. */
  stopAll(): Promise<void>;
}

/** how long a heavy server must sit unused before another heavy one may take its place */
export const SETTLE_MS = 3000;
export const KILL_AFTER_MS = 5000;
/** lines of output kept per server */
export const OUTPUT_LINES = 60;

/** one readiness probe; a server busy loading may be slow to accept */
const TRY_MS = 2000;
/** an outside server last seen answering longer ago than this is asked again before a request */
const RECHECK_MS = 10_000;
/** enough of a log's end for `OUTPUT_LINES` lines */
const TAIL_BYTES = 16 * 1024;
// oxlint-disable-next-line no-control-regex -- the escape that starts a colour code
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** `stop` on a server the app didn't start: the route answers 409. */
export class OutsideServerError extends Error {
  constructor(name: string) {
    super(`${name} was already running when the app needed it, so the app can't stop it`);
    this.name = "OutsideServerError";
  }
}

export interface LocalServersOptions {
  /** where started processes are listed, to adopt them after a restart; absent = nowhere */
  stateFile?: string;
  settleMs?: number;
  killAfterMs?: number;
  /** between readiness probes, and liveness checks of adopted processes */
  pollMs?: number;
  recheckMs?: number;
  fetch?: typeof fetch;
}

interface Run {
  key: string;
  name: string;
  baseUrl: string;
  /** what the process was, or will be, started with */
  launch: LaunchTarget;
  state: LocalServerState;
  since: number;
  pid?: number;
  /** absent for an adopted process, which isn't this one's child */
  child?: ChildProcess;
  failed?: boolean;
  /** why the last start failed */
  why?: string;
  exitCode?: number | null;
  /** when an outside server last answered */
  seen: number;
  waiting: number;
  active: number;
  /** `start` calls in flight: they keep a queued start queued with no request waiting */
  held: number;
  lastUsed: number;
  /** a start in flight, queued or spawned */
  starting?: Promise<void>;
  /** while a heavy start waits its turn */
  queued?: { go: () => void; drop: (e: unknown) => void };
  /** aborts a start: the process exited, or a stop */
  cut?: AbortController;
  halting?: Promise<void>;
  /** resolves when the child's exit is handled */
  gone?: Promise<void>;
  /** an adopted process's liveness poll */
  watch?: ReturnType<typeof setInterval>;
}

interface Saved {
  key: string;
  pid: number;
  dir: string;
  command: string;
  heavy: boolean;
}

const noop = (): void => {};

/** `ps` shows the arguments the shell made of a command: unquoted, single-spaced */
const words = (command: string): string => command.replace(/["']/g, "").replace(/\s+/g, " ").trim();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** to the process group, which `detached` made the shell's own */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

function race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason as Error);
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function readSaved(file: string): Saved[] {
  try {
    const list: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list) ? (list as Saved[]) : [];
  } catch {
    return [];
  }
}

export function createLocalServers(options: LocalServersOptions = {}): LocalServers {
  const { stateFile, settleMs = SETTLE_MS, killAfterMs = KILL_AFTER_MS, pollMs = 500 } = options;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  // a file, not a pipe: a process kept across a restart still has somewhere to write
  const logDir = stateFile
    ? join(dirname(stateFile), "local-servers")
    : mkdtempSync(join(tmpdir(), "local-servers-"));
  const logOf = (key: string): string => join(logDir, `${encodeURIComponent(key)}.log`);
  const send = options.fetch ?? fetch;
  const runs = new Map<string, Run>();
  /** heavy starts waiting their turn, first come first served */
  const queue: Run[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let written = "";

  function save(): void {
    if (!stateFile) return;
    const list: Saved[] = [...runs.values()]
      .filter((r) => r.pid !== undefined)
      .map((r) => ({
        key: r.key,
        pid: r.pid!,
        dir: r.launch.dir,
        command: r.launch.command,
        heavy: r.launch.heavy,
      }));
    const text = JSON.stringify(list);
    if (text === written) return;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, text);
    written = text;
  }

  function set(r: Run, state: LocalServerState): void {
    r.state = state;
    r.since = Date.now();
    save();
  }

  function entry(key: string, name: string, baseUrl: string, launch: LaunchTarget): Run {
    let r = runs.get(key);
    if (!r) {
      r = {
        key,
        name,
        baseUrl,
        launch,
        state: "stopped",
        since: Date.now(),
        seen: 0,
        waiting: 0,
        active: 0,
        held: 0,
        lastUsed: 0,
      };
      runs.set(key, r);
    }
    return r;
  }

  /** The last `OUTPUT_LINES` lines of its log, read from the end. */
  function output(key: string): string[] {
    let fd: number;
    try {
      fd = openSync(logOf(key), "r");
    } catch {
      return [];
    }
    try {
      const { size } = fstatSync(fd);
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString().split("\n");
      // cut mid-line
      if (start > 0) lines.shift();
      return lines
        .map((l) =>
          l
            .slice(l.lastIndexOf("\r") + 1)
            .replace(ANSI, "")
            .trimEnd(),
        )
        .filter(Boolean)
        .slice(-OUTPUT_LINES);
    } finally {
      closeSync(fd);
    }
  }

  function exited(r: Run, pid: number, code: number | null): void {
    if (r.pid !== pid) return;
    clearInterval(r.watch);
    r.pid = r.child = r.watch = undefined;
    r.exitCode = code;
    const said = code === null ? "it exited" : `it exited with code ${code}`;
    if (r.state === "starting") r.cut?.abort(new Error(said));
    else if (r.state === "running") set(r, "crashed");
    else if (r.state === "stopping") set(r, "stopped");
    save();
    pump();
  }

  function spawnIn(r: Run): void {
    const { dir, command } = r.launch;
    mkdirSync(logDir, { recursive: true });
    const log = logOf(r.key);
    // emptied first, so a failure never quotes the last run's output
    const fd = openSync(log, "w");
    let child: ChildProcess;
    try {
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`its folder ${dir} doesn't exist`);
      child = spawn("/bin/sh", ["-c", command], {
        cwd: dir,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    const pid = child.pid;
    if (pid === undefined) throw new Error("its command couldn't be run");
    r.exitCode = undefined;
    r.pid = pid;
    r.child = child;
    let done = noop;
    r.gone = new Promise((resolve) => (done = resolve));
    child.once("exit", (code) => {
      exited(r, pid, code);
      done();
    });
    child.on("error", (e) => appendFileSync(log, `${e.message}\n`));
    save();
  }

  async function answers(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
    if (!baseUrl) return false;
    const timeout = AbortSignal.timeout(TRY_MS);
    try {
      const res = await send(baseUrl, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      void res.body?.cancel().catch(noop);
      return true;
    } catch {
      return false;
    }
  }

  async function ready(r: Run, signal: AbortSignal): Promise<void> {
    const sec = r.launch.readySec ?? DEFAULT_READY_SEC;
    const deadline = Date.now() + sec * 1000;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      if (await answers(r.baseUrl, signal)) return;
      if (signal.aborted) throw signal.reason;
      if (Date.now() >= deadline) throw new Error(`it didn't answer within ${sec} s`);
      await sleep(pollMs, signal);
    }
  }

  function failure(r: Run): ProviderError {
    const last = output(r.key).at(-1);
    return new ProviderError(
      `${r.name} didn't start: ${r.why}${last ? `. It last said: ${last}` : ""}. ` +
        `Press Start on the Endpoints page to try again.`,
      0,
      false,
    );
  }

  const stopped = (r: Run): ProviderError =>
    new ProviderError(`${r.name} was stopped before it answered`, 0, false);

  /** SIGTERM to the group, SIGKILL after `killAfterMs`; done when the whole group is gone. */
  function halt(r: Run): Promise<void> {
    if (r.state === "starting" || r.state === "running") {
      set(r, "stopping");
      r.cut?.abort(stopped(r));
    }
    const pid = r.pid;
    if (pid === undefined) {
      if (r.state === "stopping") set(r, "stopped");
      return Promise.resolve();
    }
    return (r.halting ??= (async () => {
      signalGroup(pid, "SIGTERM");
      const deadline = Date.now() + killAfterMs;
      let killed = false;
      while (alive(-pid)) {
        if (!killed && Date.now() >= deadline) {
          signalGroup(pid, "SIGKILL");
          killed = true;
        }
        await delay(Math.min(pollMs, 50));
      }
      if (r.pid === pid) {
        if (r.child) await r.gone;
        else exited(r, pid, null);
      }
    })().finally(() => (r.halting = undefined)));
  }

  /** Lets the first queued heavy start go once every other heavy server has settled. */
  function pump(): void {
    clearTimeout(timer);
    const r = queue[0];
    if (!r) return;
    const now = Date.now();
    const others = [...runs.values()].filter(
      (x) =>
        x !== r &&
        x.launch.heavy &&
        (x.state === "starting" || x.state === "running" || x.state === "stopping"),
    );
    let wait = 0;
    for (const x of others) {
      if (x.state === "stopping") continue;
      // its release pumps again
      if (x.active || x.waiting) return;
      wait = Math.max(wait, x.lastUsed + settleMs - now);
    }
    if (wait > 0) {
      timer = setTimeout(pump, wait);
      timer.unref();
      return;
    }
    queue.shift();
    const { go, drop } = r.queued!;
    r.queued = undefined;
    r.lastUsed = now;
    set(r, "starting");
    Promise.all(others.map(halt)).then(go, drop);
  }

  /** Calls off a start not yet spawned: no one wants it any more, or a stop. */
  function withdraw(r: Run, why: unknown): void {
    if (!r.starting || r.state === "starting") return;
    r.cut?.abort(why);
    const q = r.queued;
    if (!q) return;
    queue.splice(queue.indexOf(r), 1);
    r.queued = undefined;
    q.drop(why);
    pump();
  }

  async function launch(r: Run): Promise<void> {
    const cut = (r.cut = new AbortController());
    set(r, "queued");
    try {
      if (await answers(r.baseUrl, cut.signal)) {
        r.seen = Date.now();
        return set(r, "outside");
      }
      if (cut.signal.aborted) throw cut.signal.reason;
      if (r.launch.heavy)
        await new Promise<void>((go, drop) => {
          r.queued = { go, drop };
          queue.push(r);
          pump();
        });
      else {
        r.lastUsed = Date.now();
        set(r, "starting");
      }
    } catch (e) {
      if (r.state === "queued") set(r, "stopped");
      throw e;
    }
    try {
      if (cut.signal.aborted) throw cut.signal.reason;
      spawnIn(r);
      await ready(r, cut.signal);
      r.failed = r.why = undefined;
      r.lastUsed = Date.now();
      set(r, "running");
    } catch (e) {
      // a stop: it set the state
      if (r.state !== "starting") throw e;
      r.why = e instanceof Error ? e.message : String(e);
      if (r.pid !== undefined) await halt(r);
      r.failed = true;
      set(r, "crashed");
      throw failure(r);
    }
  }

  const changed = (r: Run, t: LaunchTarget): boolean =>
    r.launch.dir !== t.dir || r.launch.command !== t.command;

  async function ensure(r: Run, t: Launchable, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      r.name = t.name;
      r.baseUrl = t.baseUrl;
      if (r.starting) {
        await race(r.starting, signal);
        continue;
      }
      if (r.failed) throw failure(r);
      if (r.state === "outside") {
        if (Date.now() - r.seen < recheckMs) return;
        if (await answers(r.baseUrl, signal)) {
          r.seen = Date.now();
          return;
        }
        if (signal.aborted) throw signal.reason;
        // still outside unless another request already found it gone
        if (r.state === "outside") set(r, "stopped");
        continue;
      }
      if (r.state === "running" && !changed(r, t.localServer)) {
        r.launch = t.localServer;
        return;
      }
      if (r.state === "running" || r.state === "stopping") {
        await race(halt(r), signal);
        continue;
      }
      r.launch = t.localServer;
      const p: Promise<void> = launch(r).finally(() => {
        if (r.starting === p) r.starting = undefined;
      });
      p.catch(noop);
      r.starting = p;
    }
  }

  function adopt(): void {
    if (!stateFile) return;
    for (const s of readSaved(stateFile)) {
      const said = spawnSync("ps", ["-o", "command=", "-p", String(s.pid)], { encoding: "utf8" });
      if (!alive(s.pid) || !words(said.stdout ?? "").includes(words(s.command))) continue;
      const r = entry(s.key, s.key, "", {
        key: s.key,
        dir: s.dir,
        command: s.command,
        heavy: s.heavy,
      });
      r.state = "running";
      r.pid = s.pid;
      r.lastUsed = Date.now();
      r.watch = setInterval(() => alive(s.pid) || exited(r, s.pid, null), pollMs);
      r.watch.unref();
    }
    save();
  }
  adopt();

  const servers: LocalServers = {
    async use(target, signal) {
      const { key } = target.localServer;
      const r = entry(key, target.name, target.baseUrl, target.localServer);
      r.waiting++;
      try {
        await ensure(r, target, signal);
      } catch (e) {
        r.waiting--;
        if (!r.waiting && !r.held) withdraw(r, e);
        pump();
        throw e;
      }
      r.waiting--;
      r.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        r.active--;
        r.lastUsed = Date.now();
        pump();
      };
    },

    async start(target) {
      const { key } = target.localServer;
      const r = entry(key, target.name, target.baseUrl, target.localServer);
      r.failed = r.why = undefined;
      if (r.state === "outside" && !(await answers(target.baseUrl))) set(r, "stopped");
      r.held++;
      try {
        await ensure(r, target, new AbortController().signal);
      } finally {
        r.held--;
      }
    },

    async stop(key) {
      const r = runs.get(key);
      if (!r) return;
      if (r.state === "outside") throw new OutsideServerError(r.name);
      withdraw(r, stopped(r));
      await halt(r);
      if (r.state !== "stopped") set(r, "stopped");
    },

    status() {
      return Object.fromEntries(
        [...runs.values()].map((r) => [
          r.key,
          {
            state: r.state,
            since: r.since,
            ...(r.pid !== undefined && { pid: r.pid }),
            waiting: r.waiting,
            active: r.active,
            ...(r.failed && { failed: true }),
            ...(r.exitCode !== undefined && { exitCode: r.exitCode }),
            output: r.state === "outside" ? [] : output(r.key),
          },
        ]),
      );
    },

    async stopAll() {
      await Promise.all(
        [...runs.values()].filter((r) => r.state !== "outside").map((r) => servers.stop(r.key)),
      );
    },
  };
  return servers;
}

let shared: LocalServers | undefined;
// made on first use, so importing this never reads the state file or adopts a process
const one = (): LocalServers =>
  (shared ??= createLocalServers({ stateFile: env.LOCAL_SERVERS_FILE }));

/** The app's: every library's requests share the machine's processes and VRAM. */
export const localServers: LocalServers = {
  use: (target, signal) => one().use(target, signal),
  start: (target) => one().start(target),
  stop: (key) => one().stop(key),
  status: () => one().status(),
  stopAll: () => one().stopAll(),
};
