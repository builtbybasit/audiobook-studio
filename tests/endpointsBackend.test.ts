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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { credentials, type Credential } from "@/lib/credentials";
import { ApiError } from "@/services/http";
import {
  setEndpointSettingsService,
  type EndpointConfig,
  type EndpointSettings,
  type EndpointSettingsService,
} from "@/services/endpointSettings";
import { useEndpointsStore, WRITE_DELAY_MS } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import { clone } from "@/lib/utils";
import type { Endpoint } from "@/types";
import { testPinia, type TestPinia } from "./support/pinia";

const TELEMETRY = ["history", "failures", "rateLimits", "backoffUntil", "lastError", "fetching"];

/** What the server keeps, and every write it was sent. */
class FakeService implements EndpointSettingsService {
  held: EndpointConfig | null = null;
  puts: EndpointConfig[] = [];
  gets = 0;
  /** the next write is refused with this */
  refuse: ApiError | null = null;

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
      })),
      profiles: clone(held.profiles),
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
    for (const e of stored.endpoints)
      for (const k of TELEMETRY) delete (e as unknown as Record<string, unknown>)[k];
    this.held = stored;
    return this.answer();
  }
}

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Past the write-behind's delay, and the answer's turn after it. */
const settle = () => wait(WRITE_DELAY_MS + 50);

beforeEach(() => {
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
    expect(svc.puts).toHaveLength(0); // nothing goes out while the configuration is still moving
    await settle();
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
    await wait(0);
    release(); // …and lands after 9 was typed
    await wait(0);
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
