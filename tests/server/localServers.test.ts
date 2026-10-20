// The launcher against real tiny servers (`bun -e` on a free port): starting on use, the heavy
// switch, a start that fails, a server already running, a cancel while waiting, adopting
// processes after a restart, and `call` holding its server until a streamed body is read.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LocalServer } from "@/types";
import { call, ProviderError } from "~/providers/http";
import type { ProviderTarget } from "~/providers/target";
import {
  createLocalServers,
  isReady,
  type Launchable,
  type LocalServers,
  type LocalServersOptions,
  OutsideServerError,
} from "~/servers/localServers";

const SETTLE_MS = 300;
const made: LocalServers[] = [];
const spawned: { kill(): void }[] = [];

function servers(options: LocalServersOptions = {}): LocalServers {
  const s = createLocalServers({ settleMs: SETTLE_MS, killAfterMs: 1000, pollMs: 50, ...options });
  made.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((s) => s.stopAll()));
  for (const p of spawned.splice(0)) p.kill();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** `/health` says loading for `loadingMs`, as OmniVoice does while its model loads */
const serving = (port: number, loadingMs = 0): string[] => [
  process.execPath,
  "-e",
  `const t = Date.now(); Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: (r) => new URL(r.url).pathname === "/health" ? Response.json({ status: Date.now() - t < ${loadingMs} ? "loading" : "ok" }) : new Response("ok") }); console.log("listening")`,
];

async function local(
  key: string,
  over: Partial<LocalServer> = {},
  loadingMs = 0,
): Promise<Launchable> {
  const port = await freePort();
  const [bun, flag, code] = serving(port, loadingMs);
  return {
    name: key,
    baseUrl: `http://127.0.0.1:${port}`,
    localServer: {
      key,
      dir: tmpdir(),
      command: `"${bun}" ${flag} '${code}'`,
      heavy: false,
      ...over,
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const never = new AbortController().signal;

describe("local servers", () => {
  test("a request starts its server and goes once its health says it is ready", async () => {
    const s = servers();
    const a = await local("a", {}, 400);
    const asked = Date.now();
    const release = await s.use(a, never);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(400);
    expect(s.status().a).toMatchObject({ state: "running", active: 1 });
    expect((await fetch(a.baseUrl)).ok).toBe(true);
    release();
    release();
    expect(s.status().a!.active).toBe(0);
  });

  test("a heavy server waits for the running heavy one to settle, then replaces it", async () => {
    const s = servers();
    const a = await local("a", { heavy: true });
    const b = await local("b", { heavy: true });
    const light = await local("light");
    const releaseA = await s.use(a, never);
    const pidA = s.status().a!.pid!;
    let startedB = false;
    const usingB = s.use(b, never).then((release) => {
      startedB = true;
      return release;
    });
    await Bun.sleep(SETTLE_MS * 2);
    expect(startedB).toBe(false);
    expect(s.status().b!.state).toBe("queued");
    // the running one keeps taking requests meanwhile
    (await s.use(a, never))();
    const releasedAt = Date.now();
    releaseA();
    (await usingB)();
    expect(Date.now() - releasedAt).toBeGreaterThanOrEqual(SETTLE_MS);
    expect(alive(pidA)).toBe(false);
    (await s.use(light, never))();
    expect(s.status()).toMatchObject({ b: { state: "running" }, light: { state: "running" } });
  });

  test("a start that fails refuses requests until Start is pressed", async () => {
    const s = servers();
    const broken = await local("x", { command: "echo boom; exit 3" });
    const failed = await s.use(broken, never).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ProviderError);
    expect(failed).toMatchObject({ retryable: false, message: expect.stringContaining("boom") });
    expect(s.status().x).toMatchObject({ state: "crashed", failed: true, exitCode: 3 });
    const fixed = await local("x");
    await expect(s.use(fixed, never)).rejects.toThrow("Press Start");
    await s.start(fixed);
    expect(s.status().x).toMatchObject({ state: "running" });
    expect(s.status().x!.failed).toBeUndefined();
  });

  test("a server that already answers is used, never spawned or stopped, until it goes", async () => {
    const s = servers({ recheckMs: 0 });
    const outside = await local("o");
    const port = Number(new URL(outside.baseUrl).port);
    const proc = Bun.spawn(serving(port));
    spawned.push(proc);
    for (let i = 0; i < 100 && !(await fetch(outside.baseUrl).catch(() => null)); i++)
      await Bun.sleep(20);
    (await s.use(outside, never))();
    expect(s.status().o).toMatchObject({ state: "outside" });
    expect(s.status().o!.pid).toBeUndefined();
    await expect(s.stop("o")).rejects.toBeInstanceOf(OutsideServerError);
    await s.stopAll();
    expect(alive(proc.pid)).toBe(true);
    proc.kill();
    await proc.exited;
    (await s.use(outside, never))();
    expect(s.status().o).toMatchObject({ state: "running", pid: expect.any(Number) });
  });

  test("a cancel while waiting rejects with its reason and calls the switch off", async () => {
    const s = servers();
    const a = await local("a", { heavy: true });
    const b = await local("b", { heavy: true });
    const releaseA = await s.use(a, never);
    const cancel = new AbortController();
    const waiting = s.use(b, cancel.signal);
    expect(s.status().b!.waiting).toBe(1);
    const reason = new Error("cancelled");
    cancel.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(s.status().b!.waiting).toBe(0);
    releaseA();
    await Bun.sleep(SETTLE_MS * 2);
    expect(s.status()).toMatchObject({ a: { state: "running" }, b: { state: "stopped" } });
  });

  test("a restart adopts the servers the last process started, output and all", async () => {
    const stateFile = join(tmpdir(), "local-servers.json");
    const before = servers({ stateFile });
    const a = await local("scripting:a", { heavy: true });
    (await before.use(a, never))();
    const { pid } = before.status()["scripting:a"]!;
    const after = servers({ stateFile });
    expect(after.status()["scripting:a"]).toMatchObject({
      state: "running",
      pid,
      output: ["listening"],
    });
    await after.stop("scripting:a");
    expect(alive(pid!)).toBe(false);
  });

  test("call holds a streamed answer's server until its body is read", async () => {
    const s = servers();
    const a = await local("a");
    const target: ProviderTarget = {
      id: "a",
      name: "a",
      baseUrl: a.baseUrl,
      model: "m",
      apiKey: null,
      needsKey: false,
      timeoutSec: 5,
      maxRetries: 0,
      cooldownSec: 0,
      localServer: a.localServer,
    };
    const res = await call(target, a.baseUrl, {}, { signal: never, headersOnly: true, servers: s });
    expect(s.status().a!.active).toBe(1);
    expect(await res.text()).toBe("ok");
    expect(s.status().a!.active).toBe(0);
  });

  test.each([
    ["no health route", new Response("nope", { status: 404 }), true],
    ["still loading (OmniVoice)", Response.json({ status: "loading" }), false],
    [
      "loading model (llama.cpp style)",
      Response.json({ status: "loading model" }, { status: 503 }),
      false,
    ],
    ["ok", Response.json({ status: "ok" }), true],
    ["a plain 200", new Response("ok"), true],
  ])("health: %s", async (_, res, ready) => {
    expect(await isReady(res)).toBe(ready);
  });
});
