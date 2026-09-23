// The endpoints store with a server answering.
//
// The configuration — speech endpoints, scripting profiles, the credential registry — is the
// server's in backend mode, and the page edits it by binding fields straight onto the objects. So
// what these guard is the write-behind: that the store reads the server's configuration and holds
// it, that a server nobody has configured is given the seeded one exactly once, that an edit
// becomes one whole-document write a moment later with the browser's telemetry left out, that the
// server's answer being installed is not mistaken for an edit and sent back, and that a refused
// write puts back what the server actually holds.
//
// The service here is a fake that keeps the document in memory, not the Hono app: the subject is
// the store's side of the seam, and the route has its own tests in `tests/server/`.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { credentials, type Credential } from "@/lib/credentials";
import { keyring } from "@/lib/keyring";
import { ApiError } from "@/services/http";
import {
  HttpEndpointSettingsService,
  keyInPlace,
  setEndpointSettingsService,
  type EndpointConfig,
  type EndpointProbe,
  type EndpointSettings,
  type EndpointSettingsService,
} from "@/services/endpointSettings";
import { useEndpointsStore, WRITE_DELAY_MS } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import { clone } from "@/lib/utils";
import type { Endpoint, EndpointKind } from "@/types";
import { testPinia, type TestPinia } from "./support/pinia";

const TELEMETRY = ["history", "failures", "rateLimits", "backoffUntil", "lastError", "fetching"];

/** What the server keeps, and every write it was sent. */
class FakeService implements EndpointSettingsService {
  held: EndpointConfig | null = null;
  puts: EndpointConfig[] = [];
  gets = 0;
  /** the next write is refused with this */
  refuse: ApiError | null = null;
  /** keys by `<kind>:<id>`, kept the way the server keeps them: write-only */
  keys = new Map<string, string>();
  tests: { kind: EndpointKind; id: string }[] = [];
  probe: EndpointProbe | ApiError = { ok: true, message: "tts-1 answered", ms: 840 };

  answer(): EndpointSettings {
    const held = this.held ?? { endpoints: [], profiles: [], credentials: [] };
    return {
      // the server's shape: telemetry empty, never what the browser sent
      endpoints: clone(held.endpoints).map((e) => ({
        ...e,
        history: [],
        failures: 0,
        rateLimits: 0,
        backoffUntil: 0,
        ...(this.keys.has("tts:" + e.id) ? { hasKey: true } : {}),
      })),
      profiles: clone(held.profiles).map((p) => ({
        ...p,
        ...(this.keys.has("scripting:" + p.id) ? { hasKey: true } : {}),
      })),
      credentials: clone(held.credentials),
      saved: this.held !== null,
    };
  }
  async getSettings(): Promise<EndpointSettings> {
    this.gets++;
    return this.answer();
  }
  async putSettings(body: EndpointConfig): Promise<EndpointSettings> {
    this.puts.push(clone(body));
    if (this.refuse) {
      const e = this.refuse;
      this.refuse = null;
      throw e;
    }
    const stored = clone(body);
    // absent keeps the key, "" forgets it, anything else replaces it; `hasKey` sent is ignored
    const take = (kind: EndpointKind, e: { id: string; apiKey?: string; hasKey?: boolean }) => {
      if (e.apiKey === "") this.keys.delete(`${kind}:${e.id}`);
      else if (e.apiKey !== undefined) this.keys.set(`${kind}:${e.id}`, e.apiKey);
      delete e.apiKey;
      delete e.hasKey;
    };
    for (const e of stored.endpoints) {
      for (const k of TELEMETRY) delete (e as unknown as Record<string, unknown>)[k];
      take("tts", e);
    }
    for (const p of stored.profiles) take("scripting", p);
    this.held = stored;
    return this.answer();
  }
  async testEndpoint(kind: EndpointKind, id: string): Promise<EndpointProbe> {
    this.tests.push({ kind, id });
    if (this.probe instanceof ApiError) throw this.probe;
    return this.probe;
  }
}

/** Which entries of a write carried a key, and what it was. */
const keysSent = (body: EndpointConfig) =>
  [
    ...body.endpoints.map((e) => ["tts:" + e.id, e.apiKey] as const),
    ...body.profiles.map((p) => ["scripting:" + p.id, p.apiKey] as const),
  ].filter(([, k]) => k !== undefined);

const server = (): EndpointConfig => ({
  endpoints: [
    {
      id: "srv-tts",
      name: "Server speech",
      baseUrl: "https://speech.example",
      model: "tts-1",
      concurrency: 3,
      enabled: true,
      latency: 800,
      failRate: 0,
      price: 15,
      needsKey: true,
      maxChars: 0,
      splitAt: "sentence",
      voices: [{ id: "alloy", label: "Alloy", gender: "n" }],
      sampleRate: 24000,
      credentialId: "srv-cred",
    } as Omit<Endpoint, "history" | "failures" | "rateLimits" | "backoffUntil">,
  ],
  profiles: [],
  credentials: [{ id: "srv-cred", label: "Server key", note: "" }],
});

let pinia: TestPinia;
let svc: FakeService;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let toasts: { msg: string; kind?: string }[];
/** the registry is module state; every test puts it back */
let registry: Credential[];

// The write-behind waits on a timer, and the clock is faked so the suite does not sit out
// WRITE_DELAY_MS a dozen times over. Everything else here is promises, so letting them run is one
// turn of the real event loop: `setImmediate` is taken before the clock is faked.
const realImmediate = setImmediate;
/** Let every promise that can settle, settle. */
const drain = () => new Promise<void>((r) => realImmediate(() => r()));
/** Move the fake clock on, with the watch's turn before it and the answer's turn after it. */
const wait = async (ms: number) => {
  await drain();
  jest.advanceTimersByTime(ms);
  await drain();
};
/** Past the write-behind's delay, and the answer's turn after it. */
const settle = () => wait(WRITE_DELAY_MS);

beforeEach(() => {
  jest.useFakeTimers();
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  registry = clone([...credentials]);
  svc = new FakeService();
  setEndpointSettingsService(svc);
  pinia = testPinia();
  endpointsStore = useEndpointsStore();
  toasts = [];
  useUiStore().toast = (msg, opts = {}) => {
    toasts.push({ msg, kind: opts.kind });
    return "";
  };
});

afterEach(() => {
  endpointsStore._detach();
  pinia.stop();
  setEndpointSettingsService(null);
  credentials.splice(0, credentials.length, ...registry);
  jest.useRealTimers();
});

describe("the endpoints store with a server answering", () => {
  test("load holds the server's endpoints, profiles and credentials, not the seeded ones", async () => {
    svc.held = server();
    await endpointsStore.load();
    expect(endpointsStore.endpoints.map((e) => e.id)).toEqual(["srv-tts"]);
    expect(endpointsStore.endpoints[0].sampleRate).toBe(24000);
    expect(endpointsStore.profiles).toEqual([]);
    // the registry is refilled in place: the Connection tab holds this very array
    expect(credentials.map((c) => c.id)).toEqual(["srv-cred"]);
    // telemetry is the browser's, and a new endpoint starts with none
    expect(endpointsStore.endpoints[0].history).toEqual([]);
    expect(svc.puts).toEqual([]);
    // a second load is a no-op; `force` reads again
    await endpointsStore.load();
    expect(svc.gets).toBe(1);
  });

  test("an endpoint that survives a load keeps its object and its telemetry", async () => {
    const seeded = endpointsStore.endpoints[0];
    seeded.history = [{ t: 1, ms: 100, ok: true }];
    seeded.failures = 2;
    const cfg = server();
    cfg.endpoints[0] = { ...cfg.endpoints[0], id: seeded.id };
    svc.held = cfg;
    await endpointsStore.load();
    expect(endpointsStore.endpoints[0]).toBe(seeded);
    expect(seeded.name).toBe("Server speech");
    expect(seeded.history).toEqual([{ t: 1, ms: 100, ok: true }]);
    expect(seeded.failures).toBe(2);
  });

  test("a server nobody has configured is given the seeded configuration, once", async () => {
    const seeded = endpointsStore.endpoints.map((e) => e.id);
    const seededProfiles = endpointsStore.profiles.map((p) => p.id);
    const seededCredentials = credentials.map((c) => c.id);
    await endpointsStore.load();
    expect(svc.puts).toHaveLength(1);
    expect(svc.puts[0].endpoints.map((e) => e.id)).toEqual(seeded);
    expect(svc.puts[0].profiles.map((p) => p.id)).toEqual(seededProfiles);
    expect(svc.puts[0].credentials.map((c) => c.id)).toEqual(seededCredentials);
    for (const e of svc.puts[0].endpoints)
      for (const k of TELEMETRY) expect(e).not.toHaveProperty(k);
    // the answer is what the store now holds, and installing it is not an edit to send back
    expect(endpointsStore.endpoints.map((e) => e.id)).toEqual(seeded);
    await settle();
    expect(svc.puts).toHaveLength(1);
  });

  test("edits become one debounced write of the whole configuration, telemetry left out", async () => {
    svc.held = server();
    await endpointsStore.load();
    const ep = endpointsStore.endpoints[0];
    ep.sampleRate = 48000;
    ep.concurrency = 7;
    await wait(10);
    ep.concurrency = 8;
    // nothing goes out while the configuration is still moving, and the delay runs from the last
    // change rather than the first
    await wait(WRITE_DELAY_MS - 1);
    expect(svc.puts).toHaveLength(0);
    await wait(1);
    expect(svc.puts).toHaveLength(1);
    const sent = svc.puts[0].endpoints[0];
    expect(sent.sampleRate).toBe(48000);
    expect(sent.concurrency).toBe(8);
    for (const k of TELEMETRY) expect(sent).not.toHaveProperty(k);
    expect(svc.puts[0].credentials).toEqual([{ id: "srv-cred", label: "Server key", note: "" }]);
    // and the answer landing sends nothing more
    await settle();
    expect(svc.puts).toHaveLength(1);
  });

  test("telemetry moving is not an edit", async () => {
    svc.held = server();
    await endpointsStore.load();
    const ep = endpointsStore.endpoints[0];
    ep.history = [...ep.history, { t: 2, ms: 300, ok: false }];
    ep.failures++;
    ep.lastError = { code: 500, message: "boom", body: "" };
    ep.fetching = true;
    await settle();
    expect(svc.puts).toEqual([]);
  });

  test("a credential or a profile changing is sent too", async () => {
    svc.held = server();
    await endpointsStore.load();
    credentials[0].note = "the team account";
    endpointsStore.addScriptProfile();
    await settle();
    expect(svc.puts).toHaveLength(1);
    expect(svc.puts[0].credentials[0].note).toBe("the team account");
    expect(svc.puts[0].profiles).toHaveLength(1);
  });

  test("an answer that differs from what was sent is installed, and not sent back", async () => {
    svc.held = server();
    await endpointsStore.load();
    // a server that normalises what it stores: the name comes back trimmed
    const put = svc.putSettings.bind(svc);
    svc.putSettings = async (body) => {
      const answer = await put(body);
      answer.endpoints[0].name = answer.endpoints[0].name.trim();
      svc.held!.endpoints[0].name = answer.endpoints[0].name;
      return answer;
    };
    const ep = endpointsStore.endpoints[0];
    ep.name = "  Renamed  ";
    await settle();
    expect(svc.puts).toHaveLength(1);
    expect(ep.name).toBe("Renamed");
    await settle();
    expect(svc.puts).toHaveLength(1);
  });

  test("a refused write is said, and the server's configuration read back", async () => {
    svc.held = server();
    await endpointsStore.load();
    svc.refuse = new ApiError("An endpoint names a credential that is not in the registry", 400);
    const ep = endpointsStore.endpoints[0];
    ep.credentialId = "nobody";
    await settle();
    expect(svc.puts).toHaveLength(1);
    expect(toasts.at(-1)).toEqual({
      msg: "An endpoint names a credential that is not in the registry",
      kind: "error",
    });
    expect(svc.gets).toBe(2);
    expect(endpointsStore.endpoints[0].credentialId).toBe("srv-cred");
    // what was read back is what the server holds, so it is not sent again
    await settle();
    expect(svc.puts).toHaveLength(1);
  });

  test("an answer overtaken by a later edit is not installed over it", async () => {
    svc.held = server();
    await endpointsStore.load();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const put = svc.putSettings.bind(svc);
    svc.putSettings = async (body) => {
      await gate;
      return put(body);
    };
    const ep = endpointsStore.endpoints[0];
    ep.concurrency = 5;
    await settle(); // the write for 5 is out and held
    ep.concurrency = 9;
    await drain();
    release(); // …and lands after 9 was typed
    await drain();
    expect(ep.concurrency).toBe(9);
    await settle();
    expect(svc.puts.map((b) => b.endpoints[0].concurrency)).toEqual([5, 9]);
    expect(ep.concurrency).toBe(9);
  });
});

describe("the endpoints store in the demo", () => {
  test("reads nothing and writes nothing", async () => {
    setEndpointSettingsService(null);
    const before = endpointsStore.endpoints.map((e) => e.id);
    await endpointsStore.load();
    endpointsStore.endpoints[0].concurrency = 11;
    await settle();
    expect(endpointsStore.endpoints.map((e) => e.id)).toEqual(before);
    expect(svc.gets).toBe(0);
    expect(svc.puts).toEqual([]);
    expect(endpointsStore.loaded).toBe(false);
  });
});

describe("API keys with a server answering", () => {
  test("a typed key goes out once, on its own entry, and only hasKey comes back", async () => {
    svc.held = server();
    await endpointsStore.load();
    const ep = endpointsStore.endpoints[0];
    expect(keyInPlace(ep, ep.id)).toBe(false);

    expect(await endpointsStore.saveKey("tts", "srv-tts", "sk-typed")).toBe(true);
    expect(svc.puts).toHaveLength(1);
    expect(keysSent(svc.puts[0])).toEqual([["tts:srv-tts", "sk-typed"]]);
    expect(ep.hasKey).toBe(true);
    expect(keyInPlace(ep, ep.id)).toBe(true);
    // the key is never on what the store holds…
    expect(JSON.stringify(endpointsStore.$state)).not.toContain("sk-typed");
    // …so the next edit keeps it by saying nothing about it, and installing `hasKey` sent nothing
    await settle();
    expect(svc.puts).toHaveLength(1);
    ep.concurrency = 9;
    await settle();
    expect(svc.puts).toHaveLength(2);
    expect(keysSent(svc.puts[1])).toEqual([]);
    expect(svc.keys.get("tts:srv-tts")).toBe("sk-typed");
    expect(ep.hasKey).toBe(true);
  });

  test("removing sends an empty key, and hasKey goes", async () => {
    svc.held = server();
    svc.keys.set("tts:srv-tts", "sk-old");
    await endpointsStore.load();
    const ep = endpointsStore.endpoints[0];
    expect(ep.hasKey).toBe(true);
    await endpointsStore.saveKey("tts", "srv-tts", "");
    expect(keysSent(svc.puts[0])).toEqual([["tts:srv-tts", ""]]);
    expect(svc.keys.has("tts:srv-tts")).toBe(false);
    expect(ep).not.toHaveProperty("hasKey");
  });

  test("a scripting profile's key is its own, and a pending edit rides along with it", async () => {
    svc.held = { ...server(), profiles: [] };
    await endpointsStore.load();
    const id = endpointsStore.addScriptProfile();
    endpointsStore.endpoints[0].concurrency = 4;
    await drain();
    // before the write-behind's timer: the key write takes what is waiting with it
    await endpointsStore.saveKey("scripting", id, "sk-chat");
    expect(svc.puts).toHaveLength(1);
    expect(keysSent(svc.puts[0])).toEqual([["scripting:" + id, "sk-chat"]]);
    expect(svc.puts[0].endpoints[0].concurrency).toBe(4);
    expect(endpointsStore.profiles[0].hasKey).toBe(true);
    await settle();
    expect(svc.puts).toHaveLength(1);
  });

  test("the key warnings read hasKey, not the browser's keyring", () => {
    keyring.set("srv-tts", "sk-in-the-browser");
    try {
      expect(keyInPlace({}, "srv-tts")).toBe(false);
      expect(keyInPlace({ hasKey: true }, "srv-tts")).toBe(true);
      setEndpointSettingsService(null);
      expect(keyInPlace({}, "srv-tts")).toBe(true);
    } finally {
      keyring.set("srv-tts", "");
    }
  });

  test("a settings file carries neither a key nor hasKey, in or out", async () => {
    svc.held = server();
    svc.keys.set("tts:srv-tts", "sk-old");
    await endpointsStore.load();
    expect(endpointsStore.exportSettings().endpoints[0]).not.toHaveProperty("hasKey");
    const file = endpointsStore.exportSettings();
    file.endpoints[0] = {
      ...file.endpoints[0],
      name: "Imported",
      apiKey: "sk-in-a-file",
      hasKey: false,
    };
    endpointsStore.importSettings(file);
    await settle();
    expect(svc.puts.at(-1)!.endpoints[0].name).toBe("Imported");
    expect(keysSent(svc.puts.at(-1)!)).toEqual([]);
    expect(svc.keys.get("tts:srv-tts")).toBe("sk-old");
    expect(endpointsStore.endpoints[0].hasKey).toBe(true);
  });
});

describe("the connection test with a server answering", () => {
  test("sends what is waiting, then asks the server about the saved endpoint", async () => {
    svc.held = server();
    await endpointsStore.load();
    endpointsStore.endpoints[0].model = "tts-2";
    await drain();
    const result = await endpointsStore.testSaved("tts", "srv-tts");
    expect(svc.puts.map((b) => b.endpoints[0].model)).toEqual(["tts-2"]);
    expect(svc.tests).toEqual([{ kind: "tts", id: "srv-tts" }]);
    expect(result).toMatchObject({
      ok: true,
      message: "tts-1 answered",
      ms: 840,
      simulated: false,
    });
    expect(result.detail).toContain("840 ms");
  });

  test("a test that could not run is a failed result, not a throw", async () => {
    svc.held = server();
    await endpointsStore.load();
    svc.probe = new ApiError("No such endpoint", 404);
    const result = await endpointsStore.testSaved("scripting", "gone");
    expect(result).toMatchObject({ ok: false, message: "Not saved on the server yet", ms: 0 });
  });

  test("the HTTP service posts the kind and id to /endpoints/test", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const http = new HttpEndpointSettingsService("/api", async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: false, message: "401: key refused", ms: 120 }));
    });
    expect(await http.testEndpoint("scripting", "openai")).toEqual({
      ok: false,
      message: "401: key refused",
      ms: 120,
    });
    expect(calls[0].url).toBe("/api/endpoints/test");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ kind: "scripting", id: "openai" });
  });
});
