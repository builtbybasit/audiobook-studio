// The order the endpoint configuration's writes reach the server in.
//
// Every write is the whole configuration, and the server takes each as the whole truth, so two out
// at once could land in either order and leave the server holding the older one. These hold the
// server's answers back and give them in the order a loaded server might — newest first — to check
// that only one write is ever out, that what changed meanwhile goes in the one write after it, and
// that a flush says how its writes went. `endpointsBackend.test.ts` has the write-behind itself.
import { afterEach, beforeEach, expect, jest, test } from "bun:test";

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

/** A server whose writes wait until the test answers them, and take effect only then. */
class HeldServer {
  held: EndpointConfig = {
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
        voices: [],
      } as Omit<Endpoint, "history" | "failures" | "rateLimits" | "backoffUntil">,
    ],
    profiles: [],
    transcribers: [],
    credentials: [],
  };
  keys = new Map<string, string>();
  /** every write sent, in the order it was sent */
  puts: EndpointConfig[] = [];
  /** writes sent and not yet answered: `answer` lands one, `refuse` turns it away */
  open: { body: EndpointConfig; answer: () => void; refuse: () => void }[] = [];

  settings(): EndpointSettings {
    return {
      ...clone(this.held),
      endpoints: this.held.endpoints.map((e) => ({
        ...clone(e),
        history: [],
        failures: 0,
        rateLimits: 0,
        backoffUntil: 0,
        ...(this.keys.has(e.id) ? { hasKey: true } : {}),
      })),
    };
  }
  service(): EndpointSettingsService {
    return {
      getSettings: async () => this.settings(),
      putSettings: (body: EndpointConfig) => {
        this.puts.push(clone(body));
        return new Promise<EndpointSettings>((resolve, reject) => {
          const write = {
            body: clone(body),
            answer: () => {
              for (const e of write.body.endpoints) {
                if (e.apiKey) this.keys.set(e.id, e.apiKey);
                delete e.apiKey;
              }
              this.held = write.body;
              resolve(this.settings());
            },
            refuse: () => reject(new ApiError("Refused", 400)),
          };
          this.open.push(write);
        });
      },
    } as Partial<EndpointSettingsService> as EndpointSettingsService;
  }
  /** Answer the newest write out first, as a server under load may, until none is out. */
  async answerNewestFirst(): Promise<void> {
    while (this.open.length) {
      this.open.pop()!.answer();
      await wait(WRITE_DELAY_MS);
    }
  }
}

const realImmediate = setImmediate;
/** Let every promise that can settle, settle. */
const drain = () => new Promise<void>((r) => realImmediate(() => r()));
/** Move the fake clock on, with the watch's turn before it and the answer's turn after it. */
const wait = async (ms: number) => {
  await drain();
  jest.advanceTimersByTime(ms);
  await drain();
};

let pinia: TestPinia;
let server: HeldServer;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let toasts: string[];

beforeEach(async () => {
  jest.useFakeTimers();
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  server = new HeldServer();
  setEndpointSettingsService(server.service());
  pinia = testPinia();
  endpointsStore = useEndpointsStore();
  toasts = [];
  useUiStore().toast = (msg) => {
    toasts.push(msg);
    return "";
  };
  await endpointsStore.load();
});

afterEach(() => {
  endpointsStore._detach();
  pinia.stop();
  setEndpointSettingsService(null);
  jest.useRealTimers();
});

test("a change made while a write is out goes after it, so the server ends on the newer one", async () => {
  const ep = endpointsStore.endpoints[0];
  ep.concurrency = 5;
  await wait(WRITE_DELAY_MS); // the write for 5 is out
  ep.concurrency = 7;
  await wait(10);
  ep.concurrency = 9;
  await wait(WRITE_DELAY_MS); // due, but 5 is still out
  await server.answerNewestFirst();
  expect(server.held.endpoints[0].concurrency).toBe(9);
  // 7 never went out on its own: the write after 5 took what stood when it was sent
  expect(server.puts.map((b) => b.endpoints[0].concurrency)).toEqual([5, 9]);
  expect(ep.concurrency).toBe(9);
  expect(await endpointsStore.flushWrites()).toBe("landed");
  expect(server.puts).toHaveLength(2);
});

test("a flush waits for the write out and the one owed after it, and they land in order", async () => {
  const ep = endpointsStore.endpoints[0];
  ep.concurrency = 5;
  await wait(WRITE_DELAY_MS);
  ep.concurrency = 9;
  const flushing = endpointsStore.flushWrites();
  await wait(0);
  expect(server.open).toHaveLength(1);
  await server.answerNewestFirst();
  expect(await flushing).toBe("landed");
  expect(server.held.endpoints[0].concurrency).toBe(9);
});

test("a key saved while a write is out rides the next write only, and lands after it", async () => {
  const ep = endpointsStore.endpoints[0];
  ep.concurrency = 5;
  await wait(WRITE_DELAY_MS);
  const saving = endpointsStore.saveKey("tts", "srv-tts", "sk-typed");
  await wait(0);
  expect(server.open).toHaveLength(1);
  await server.answerNewestFirst();
  expect(await saving).toBe(true);
  expect(server.puts.map((b) => b.endpoints[0].apiKey)).toEqual([undefined, "sk-typed"]);
  expect(server.keys.get("srv-tts")).toBe("sk-typed");
  expect(ep.hasKey).toBe(true);
  expect(JSON.stringify(endpointsStore.$state)).not.toContain("sk-typed");
  ep.concurrency = 6;
  await wait(WRITE_DELAY_MS);
  await server.answerNewestFirst();
  expect(server.puts.at(-1)!.endpoints[0].apiKey).toBeUndefined();
});

test("a refused write is what the flush says, and the server's configuration is read back", async () => {
  const ep = endpointsStore.endpoints[0];
  ep.concurrency = 5;
  const flushing = endpointsStore.flushWrites();
  await wait(0);
  server.open.pop()!.refuse();
  expect(await flushing).toBe("refused");
  expect(toasts).toEqual(["Refused"]);
  expect(ep.concurrency).toBe(3);
});
