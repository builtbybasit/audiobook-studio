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
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { GpuInfo, LocalServerState, LocalServerStatus } from "@/types";
import { DEFAULT_READY_SEC } from "@/lib/localServers";
import { env } from "~/env";
import { sleep } from "~/providers/fake";
import { ProviderError } from "~/providers/http";
import type { LaunchTarget } from "~/providers/target";
import { readGpus } from "~/servers/gpu";

/** What a server needs to be started and checked; `ProviderTarget` satisfies it. */
export interface Launchable {
  /** for messages */
  name: string;
  /** ready once `/health` at its origin says so (`isReady`) */
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
  /**
   * The Stop button: its stop command if it has one, then its process tree ends (forced after
   * `KILL_AFTER_MS`), then its URL must go quiet. Throws `OutsideServerError` when it still answers,
   * or when it is outside with no stop command.
   */
  stop(key: string): Promise<void>;
  status(): Record<string, LocalServerStatus>;
  /** Every server this app started, on shutdown. */
  stopAll(): Promise<void>;
  /** the machine's GPUs, for the page */
  gpus(): Promise<GpuInfo[]>;
}

/** how long a heavy server must sit unused before another heavy one may take its place */
export const SETTLE_MS = 3000;
export const KILL_AFTER_MS = 5000;
/** lines of output kept per server */
export const OUTPUT_LINES = 60;
/** how long a stop command may run */
export const STOP_COMMAND_MS = 30_000;

/** one readiness probe; a server busy loading may be slow to accept */
const TRY_MS = 2000;
/** an outside server last seen answering longer ago than this is asked again before a request */
const RECHECK_MS = 10_000;
/** after its process is gone, how long a server's URL may take to go quiet beyond `killAfterMs` */
const QUIET_MS = 3000;
/** between GPU memory samples while a server runs */
const SAMPLE_MS = 5000;
/** enough of a log's end for `OUTPUT_LINES` lines */
const TAIL_BYTES = 16 * 1024;
/** a `/health` status still loading the model: OmniVoice answers 200 `{status: "loading"}` */
const LOADING = /load|start|init|warm/i;
// oxlint-disable-next-line no-control-regex -- the escape that starts a colour code
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** `stop` on a server the app doesn't control (any more): the route answers 409. */
export class OutsideServerError extends Error {
  override readonly name = "OutsideServerError";
}

/** How the app runs, ends and recognises a process tree on this OS. */
export interface Platform {
  /** a group of its own, which the posix kill signals as one */
  detached: boolean;
  /** asks the tree to end; `force` once `killAfterMs` has passed */
  kill(pid: number, force: boolean): void;
  /** anything of the tree left */
  alive(pid: number): boolean;
  /** the command line it runs, or "" */
  commandOf(pid: number): string;
}

export interface LocalServersOptions {
  /** where started processes and GPU footprints are kept across a restart; absent = nowhere */
  stateFile?: string;
  settleMs?: number;
  killAfterMs?: number;
  /** between readiness probes, and liveness checks of adopted processes */
  pollMs?: number;
  recheckMs?: number;
  fetch?: typeof fetch;
  /** absent = this OS's */
  platform?: Platform;
  /** fresh within `maxAgeMs`; absent = no GPU, nothing measured */
  gpus?: (maxAgeMs?: number) => Promise<GpuInfo[]>;
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
  /** outside because a stop didn't quiet it: its log says so, so the page shows it */
  lost?: boolean;
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
  running: { pid: number; name: string; baseUrl: string; launch: LaunchTarget }[];
  /** MB of GPU memory each server took, by key */
  vram: Record<string, number>;
}

const noop = (): void => {};

/** `ps` shows the arguments the shell made of a command: unquoted, single-spaced */
const words = (command: string): string => command.replace(/["']/g, "").replace(/\s+/g, " ").trim();

/** works on Windows too: there it asks whether the process exists */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM, then SIGKILL, to the process group that `detached` made the shell's own. */
const posix: Platform = {
  detached: true,
  kill(pid, force) {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // already gone
    }
  },
  alive: (pid) => alive(-pid),
  commandOf: (pid) =>
    spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "",
};

/**
 * No process groups: `taskkill /T` walks the tree from the shell. Without `/F` it only asks, which
 * a console process ignores, so the forced kill after `killAfterMs` is the usual end.
 */
const win32: Platform = {
  detached: false,
  kill(pid, force) {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    spawnSync("taskkill", args, { windowsHide: true, timeout: 10_000 });
  },
  alive,
  commandOf: (pid) =>
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    ).stdout ?? "",
};

const usedMb = (gpus: GpuInfo[]): number | undefined =>
  gpus.length ? gpus.reduce((sum, g) => sum + g.memoryUsedMb, 0) : undefined;

function race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason as Error);
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Servers listen before their model loads, so answering isn't ready. A 404 means no health route,
 * and answering is all it can say.
 */
export async function isReady(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (!res.ok) return false;
  const body: unknown = await res.json().catch(() => null);
  const status = (body as { status?: unknown } | null)?.status;
  return !(typeof status === "string" && LOADING.test(status));
}

function readSaved(file: string): Saved {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved> | null;
    return { running: saved?.running ?? [], vram: saved?.vram ?? {} };
  } catch {
    return { running: [], vram: {} };
  }
}

export function createLocalServers(options: LocalServersOptions = {}): LocalServers {
  const { stateFile, settleMs = SETTLE_MS, killAfterMs = KILL_AFTER_MS, pollMs = 500 } = options;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const platform = options.platform ?? (process.platform === "win32" ? win32 : posix);
  const gpus = (maxAgeMs?: number): Promise<GpuInfo[]> =>
    options.gpus ? options.gpus(maxAgeMs).catch(() => []) : Promise.resolve([]);
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
  const saved = stateFile ? readSaved(stateFile) : { running: [], vram: {} };
  /** MB of GPU memory each server took above what was in use before it started */
  const vram = new Map(Object.entries(saved.vram));
  /** the server started last, while nothing else started since: the only one measurable */
  let measured: { r: Run; baseline: number } | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  const born = Date.now();

  function save(): void {
    if (!stateFile) return;
    const state: Saved = {
      running: [...runs.values()]
        .filter((r) => r.pid !== undefined)
        .map((r) => ({ pid: r.pid!, name: r.name, baseUrl: r.baseUrl, launch: r.launch })),
      vram: Object.fromEntries(vram),
    };
    const text = JSON.stringify(state);
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
    // a stop ends in `halt`, once its URL is quiet
    if (r.state === "starting") r.cut?.abort(new Error(said));
    else if (r.state === "running") set(r, "crashed");
    save();
    pump();
  }

  const dirOf = (r: Run): string => r.launch.dir || homedir();

  /** Not this app's process, but its stop command can end it. */
  const stoppable = (r: Run): boolean =>
    (r.state === "crashed" || r.state === "outside") && !!r.launch.stopCommand;

  /** `/bin/sh -c`, or `cmd.exe /d /s /c` on Windows, with its output appended to the server's log. */
  function shell(r: Run, command: string, flags: "w" | "a"): ChildProcess {
    mkdirSync(logDir, { recursive: true });
    const fd = openSync(logOf(r.key), flags);
    try {
      const dir = dirOf(r);
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`its folder ${dir} doesn't exist`);
      return spawn(command, {
        shell: true,
        cwd: dir,
        detached: platform.detached,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
  }

  function spawnIn(r: Run): void {
    const log = logOf(r.key);
    // emptied first, so a failure never quotes the last run's output
    const child = shell(r, r.launch.command, "w");
    const pid = child.pid;
    if (pid === undefined) throw new Error("its command couldn't be run");
    r.exitCode = undefined;
    r.lost = undefined;
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

  async function healthy(baseUrl: string, signal: AbortSignal): Promise<boolean> {
    try {
      const res = await send(new URL("/health", baseUrl), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRY_MS)]),
      });
      return await isReady(res);
    } catch {
      return false;
    }
  }

  async function ready(r: Run, signal: AbortSignal): Promise<void> {
    const sec = r.launch.readySec ?? DEFAULT_READY_SEC;
    const deadline = Date.now() + sec * 1000;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      if (await healthy(r.baseUrl, signal)) return;
      if (signal.aborted) throw signal.reason;
      if (Date.now() >= deadline) throw new Error(`it wasn't ready within ${sec} s`);
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

  /** Asks the tree to end, forces it after `killAfterMs`; done when the whole tree is gone. */
  async function killTree(pid: number): Promise<void> {
    platform.kill(pid, false);
    const deadline = Date.now() + killAfterMs;
    let forced = false;
    while (platform.alive(pid)) {
      if (!forced && Date.now() >= deadline) {
        platform.kill(pid, true);
        forced = true;
      }
      await delay(Math.min(pollMs, 50));
    }
  }

  /** Its stop command, output to its log, cut off after `STOP_COMMAND_MS`. */
  async function runStopCommand(r: Run, command: string): Promise<void> {
    const log = logOf(r.key);
    mkdirSync(logDir, { recursive: true });
    appendFileSync(log, `$ ${command}\n`);
    let child: ChildProcess;
    try {
      child = shell(r, command, "a");
    } catch (e) {
      appendFileSync(log, `${e instanceof Error ? e.message : String(e)}\n`);
      return;
    }
    let cap: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
        child.once("error", (e) => {
          appendFileSync(log, `${e.message}\n`);
          resolve(true);
        });
      }),
      new Promise<boolean>((resolve) => (cap = setTimeout(() => resolve(false), STOP_COMMAND_MS))),
    ]);
    clearTimeout(cap);
    if (done || child.pid === undefined) return;
    appendFileSync(log, `The stop command didn't finish within ${STOP_COMMAND_MS / 1000} s\n`);
    await killTree(child.pid);
  }

  async function quiet(baseUrl: string, deadline: number): Promise<boolean> {
    while (await answers(baseUrl)) {
      if (Date.now() >= deadline) return false;
      await delay(pollMs);
    }
    return true;
  }

  /**
   * Its stop command, then its tree ends, then its URL must go quiet: that frees the GPU, since a
   * `wsl.exe` or `docker run` client can die and leave its server running. A crashed or outside one
   * with a stop command gets it too. Rejects, and leaves it outside, when its URL still answers.
   */
  function halt(r: Run): Promise<void> {
    const pid = r.pid;
    const leftover = pid === undefined && stoppable(r);
    if (r.state === "starting" || r.state === "running" || leftover) {
      set(r, "stopping");
      r.cut?.abort(stopped(r));
    }
    if (pid === undefined && !leftover) {
      if (r.state === "stopping") set(r, "stopped");
      return Promise.resolve();
    }
    return (r.halting ??= (async () => {
      const { stopCommand } = r.launch;
      if (stopCommand) await runStopCommand(r, stopCommand);
      const deadline = Date.now() + killAfterMs + QUIET_MS;
      if (pid !== undefined) {
        await killTree(pid);
        if (r.pid === pid) {
          if (r.child) await r.gone;
          else exited(r, pid, null);
        }
      }
      if (!(await quiet(r.baseUrl, deadline))) {
        const said =
          `${r.name} still answers at ${r.baseUrl} after it was stopped, so the app leaves it ` +
          (stopCommand
            ? "alone now: check its Stop command"
            : "alone now: a Stop command can end it");
        appendFileSync(logOf(r.key), `${said}\n`);
        r.lost = true;
        r.seen = Date.now();
        set(r, "outside");
        throw new OutsideServerError(said);
      }
      if (r.state === "stopping") set(r, "stopped");
    })().finally(() => (r.halting = undefined)));
  }

  /** The heavy servers holding the GPU, which a queued heavy one waits for and then stops. */
  const heavyBesides = (r: Run): Run[] =>
    [...runs.values()].filter(
      (x) =>
        x !== r &&
        x.launch.heavy &&
        (x.state === "starting" ||
          x.state === "running" ||
          x.state === "stopping" ||
          (x.state === "outside" && stoppable(x))),
    );

  /** Raises its footprint to what is in use above the baseline, while nothing else started since. */
  async function sample(): Promise<void> {
    const m = measured;
    if (m?.r.state !== "running") {
      clearInterval(sampler);
      sampler = undefined;
      return;
    }
    const used = usedMb(await gpus());
    if (measured !== m || used === undefined || used - m.baseline <= (vram.get(m.r.key) ?? 0))
      return;
    vram.set(m.r.key, used - m.baseline);
    save();
  }

  /** Lets the first queued heavy start go once every other heavy server has settled. */
  function pump(): void {
    clearTimeout(timer);
    const r = queue[0];
    if (!r) return;
    const now = Date.now();
    const others = heavyBesides(r);
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
    Promise.all(others.map(halt)).then(go, (e: unknown) =>
      drop(new ProviderError(`${r.name} can't start: ${(e as Error).message}`, 0, false)),
    );
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
      // queued, or starting while the heavy one it replaces couldn't be stopped
      if (r.state === "queued" || r.state === "starting") set(r, "stopped");
      throw e;
    }
    try {
      const baseline = usedMb(await gpus(0));
      if (cut.signal.aborted) throw cut.signal.reason;
      spawnIn(r);
      measured = baseline === undefined ? undefined : { r, baseline };
      await ready(r, cut.signal);
      r.failed = r.why = undefined;
      r.lastUsed = Date.now();
      set(r, "running");
    } catch (e) {
      // a stop: it set the state
      if (r.state !== "starting") throw e;
      r.why = e instanceof Error ? e.message : String(e);
      if (r.pid !== undefined) await halt(r).catch(noop);
      r.failed = true;
      // `halt` leaves one that still answers outside
      if ((r.state as LocalServerState) !== "outside") set(r, "crashed");
      throw failure(r);
    }
    if (measured?.r === r) {
      void sample();
      sampler ??= setInterval(() => void sample(), SAMPLE_MS);
      sampler.unref();
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
        // its stop command is the endpoint's current one
        r.launch = t.localServer;
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
        // one that won't stop is outside now, and used as such
        await race(halt(r).catch(noop), signal);
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
    for (const s of saved.running) {
      if (!alive(s.pid) || !words(platform.commandOf(s.pid)).includes(words(s.launch.command)))
        continue;
      const r = entry(s.launch.key, s.name, s.baseUrl, s.launch);
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
      if (r.state === "outside" && !stoppable(r))
        throw new OutsideServerError(
          `${r.name} was already running when the app needed it, so the app can't stop it`,
        );
      withdraw(r, stopped(r));
      await halt(r);
      if (r.state !== "stopped") set(r, "stopped");
    },

    status() {
      const list: Record<string, LocalServerStatus> = {};
      // a footprint from an earlier run tells the page what starting it will take
      for (const [key, vramMb] of vram)
        list[key] = { state: "stopped", since: born, waiting: 0, active: 0, output: [], vramMb };
      for (const r of runs.values()) {
        const by = r.queued && heavyBesides(r)[0];
        const vramMb = vram.get(r.key);
        list[r.key] = {
          state: r.state,
          since: r.since,
          ...(r.pid !== undefined && { pid: r.pid }),
          waiting: r.waiting,
          active: r.active,
          ...(r.failed && { failed: true }),
          ...(r.exitCode !== undefined && { exitCode: r.exitCode }),
          output: r.state === "outside" && !r.lost ? [] : output(r.key),
          ...(by && { blockedBy: by.name }),
          ...(vramMb !== undefined && { vramMb }),
        };
      }
      return list;
    },

    async stopAll() {
      // outside ones stay, stop command or not: the user started them, so quitting the app doesn't
      await Promise.allSettled(
        [...runs.values()].filter((r) => r.state !== "outside").map((r) => servers.stop(r.key)),
      );
    },

    gpus: () => gpus(),
  };
  return servers;
}

let shared: LocalServers | undefined;
// made on first use, so importing this never reads the state file or adopts a process
const one = (): LocalServers =>
  (shared ??= createLocalServers({ stateFile: env.LOCAL_SERVERS_FILE, gpus: readGpus }));

/** The app's: every library's requests share the machine's processes and VRAM. */
export const localServers: LocalServers = {
  use: (target, signal) => one().use(target, signal),
  start: (target) => one().start(target),
  stop: (key) => one().stop(key),
  status: () => one().status(),
  stopAll: () => one().stopAll(),
  gpus: () => one().gpus(),
};
