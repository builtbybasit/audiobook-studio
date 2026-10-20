// The local-server routes over a fake launcher: a saved `launch` read back for every kind, Start
// finding the saved endpoint by its key and answering servers and GPUs, Stop's 409 for a server
// the app doesn't control, and the demo (no launcher) listing nothing.
import { describe, expect, test } from "bun:test";

import type {
  Endpoint,
  EndpointKind,
  GpuInfo,
  LocalServer,
  LocalServerStatus,
  Profile,
  Transcriber,
} from "@/types";
import { serverKey } from "@/lib/localServers";
import { newProfile } from "@/lib/scripting";
import { type Launchable, type LocalServers, OutsideServerError } from "~/servers/localServers";
import { jsonBody, speechEndpoint, testApi, type TestApi } from "../support/server";

interface Config {
  endpoints: Endpoint[];
  profiles: Profile[];
  transcribers: Transcriber[];
}

const LAUNCH: LocalServer = {
  dir: "/opt/voices",
  command: "./serve.sh",
  heavy: true,
  readySec: 120,
};

const transcriber = (over: Partial<Transcriber> = {}): Transcriber => ({
  id: "phonon",
  name: "Phonon",
  baseUrl: "http://127.0.0.1:8010/v1",
  model: "phonon-2",
  enabled: true,
  concurrency: 1,
  needsKey: false,
  perMinute: 0,
  ...over,
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  ...newProfile({ id: "llm", name: "Local LLM", model: "qwen", needsKey: false }),
  ...over,
});

const GPU: GpuInfo = {
  index: 0,
  name: "RTX 4060 Laptop GPU",
  memoryUsedMb: 5600,
  memoryTotalMb: 8188,
  utilization: 40,
  temperature: 61,
};

/** Records what was asked of it; `status` is what it reports, and Stop refuses an outside one. */
function fakeServers(status: Record<string, LocalServerStatus> = {}) {
  const started: Launchable[] = [];
  const stopped: string[] = [];
  const servers: LocalServers = {
    use: () => Promise.reject(new Error("no request goes in these tests")),
    start: async (target) => void started.push(target),
    async stop(key) {
      if (status[key]?.state === "outside") throw new OutsideServerError(`${key} is outside`);
      stopped.push(key);
    },
    status: () => status,
    stopAll: async () => {},
    gpus: async () => [GPU],
  };
  return { servers, started, stopped };
}

const save = (api: TestApi, config: Partial<Config>) =>
  api.request<Config>("/api/endpoints", {
    ...jsonBody({ endpoints: [], profiles: [], transcribers: [], credentials: [], ...config }),
    method: "PUT",
  });

const start = (api: TestApi, key: string) =>
  api.request<{ servers: Record<string, LocalServerStatus>; gpus: GpuInfo[] }>(
    "/api/endpoints/servers/start",
    jsonBody({ key }),
  );

const stop = (api: TestApi, key: string) =>
  api.request("/api/endpoints/servers/stop", jsonBody({ key }));

const RUNNING: LocalServerStatus = {
  state: "running",
  since: 1,
  waiting: 0,
  active: 0,
  output: [],
};

describe("local servers", () => {
  test.each<{
    kind: EndpointKind;
    id: string;
    config: Partial<Config>;
    read: (c: Config) => { launch?: LocalServer | null };
  }>([
    {
      kind: "tts",
      id: "studio",
      config: { endpoints: [speechEndpoint({ launch: LAUNCH })] },
      read: (c: Config) => c.endpoints[0],
    },
    {
      kind: "scripting",
      id: "llm",
      config: { profiles: [profile({ launch: LAUNCH })] },
      read: (c: Config) => c.profiles[0],
    },
    {
      kind: "transcription",
      id: "phonon",
      config: { transcribers: [transcriber({ launch: LAUNCH })] },
      read: (c: Config) => c.transcribers[0],
    },
  ])("a $kind endpoint's launch is kept, and Start finds it by its key", async (c) => {
    const { servers, started } = fakeServers();
    const api = testApi({ servers });
    expect(c.read((await save(api, c.config)).body).launch).toEqual(LAUNCH);
    expect(c.read((await api.request<Config>("/api/endpoints")).body).launch).toEqual(LAUNCH);

    const key = serverKey(c.kind, c.id);
    expect(await start(api, key)).toEqual({ status: 200, body: { servers: {}, gpus: [GPU] } });
    expect(started.map((t) => t.localServer)).toEqual([{ ...LAUNCH, key }]);
  });

  test.each(["studio", "transcription:", "nowhere"])(
    "Start refuses %p: no saved endpoint by that key has a local server",
    async (key) => {
      const { servers, started } = fakeServers();
      const api = testApi({ servers });
      await save(api, {
        endpoints: [speechEndpoint()],
        transcribers: [transcriber({ launch: LAUNCH })],
      });
      expect((await start(api, key)).status).toBe(404);
      expect(started).toEqual([]);
    },
  );

  test("Stop answers 409 for a server the app doesn't control", async () => {
    const { servers, stopped } = fakeServers({
      outside: { ...RUNNING, state: "outside" },
      mine: RUNNING,
    });
    const api = testApi({ servers });
    expect(await stop(api, "outside")).toMatchObject({
      status: 409,
      body: { error: { message: "outside is outside" } },
    });
    expect((await stop(api, "mine")).status).toBe(200);
    expect(stopped).toEqual(["mine"]);
  });

  test("without a launcher, as in the demo, nothing is listed, started or stopped", async () => {
    const api = testApi();
    await save(api, { endpoints: [speechEndpoint({ launch: LAUNCH })] });
    expect((await api.request("/api/endpoints/servers")).body).toEqual({ servers: {}, gpus: [] });
    expect((await start(api, "studio")).status).toBe(404);
    expect((await stop(api, "studio")).status).toBe(404);
  });

  test.each([{ ...LAUNCH, dir: "opt/voices" }])("a save refuses launch %o", async (launch) => {
    const { status } = await save(testApi(), { endpoints: [speechEndpoint({ launch })] });
    expect(status).toBe(400);
  });
});
