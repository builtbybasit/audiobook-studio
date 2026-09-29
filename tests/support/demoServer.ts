// The demo library, answering the page's services in-process: what a demo tab talks to.
//
// A store test that wants the seeded world — `cliche`, `starforge`, the seeded cast and endpoints —
// opens one of these and gets the demo exactly as the server holds it: the same `openLibrary` the
// server boots with, over a private in-memory database and temporary folders, seeded with
// `makeWorld()`, every endpoint simulated. The page's services are pointed at it, so a store
// under test asks it the way the browser asks `/demo/api`. Nothing reaches the network: the
// providers are handed a `fetch` that fails the test.
import { HttpDemoService, setDemoService } from "@/services/demo";
import type { FetchLike } from "@/services/http";
import {
  HttpEndpointSettingsService,
  setEndpointSettingsService,
} from "@/services/endpointSettings";
import { HttpJobsService, setJobsService } from "@/services/jobs";
import { HttpLibraryService, setLibraryService } from "@/services/library";
import { HttpUsageService, setUsageService } from "@/services/usage";
import { DEMO_BASE, openLibrary, type Library } from "~/libraries";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { wavEncoders } from "~/providers/wavEncoder";
import { collectingLogger, tempAudioDir, tempExportDir, tempVoiceDir } from "./server";

/** A fetch that fails the test: the demo's endpoints are simulated, and must never reach one. */
const noNetwork = (async (url: string) => {
  throw new Error(`the demo sent a request to ${url}`);
}) as unknown as typeof globalThis.fetch;

export interface DemoServer {
  library: Library;
  /** the page's `fetch`, answered by the demo library */
  fetch: FetchLike;
  /** `POST /demo/api/demo/situations/:id`, as the Demo drawer sends it */
  situate(id: string): Promise<{ note: string; open: string }>;
  /** `POST /demo/api/demo/reset` */
  reset(): Promise<void>;
  /** let every job the demo's queue holds finish */
  idle(): Promise<void>;
}

/**
 * Open a seeded demo library, start its queue, and point the page's services at it. Call it before
 * the stores under test are created: a store reads its service when its state is first built.
 */
export async function demoServer(): Promise<DemoServer> {
  const library = openLibrary({
    name: "demo",
    base: DEMO_BASE,
    databaseUrl: ":memory:",
    audioDir: tempAudioDir(),
    exportDir: tempExportDir(),
    voiceDir: tempVoiceDir(),
    encoders: wavEncoders(),
    log: collectingLogger().log,
    providers: {
      scripting: endpointScriptingProvider({ fetch: noNetwork }),
      speech: endpointSpeechProvider({ fetch: noNetwork }),
    },
    demo: true,
    // a store test reasons about the queue, which the demo's startup runs would keep busy
    still: true,
  });
  await library.start();
  const fetch: FetchLike = async (input, init) =>
    library.app.request(new Request(`http://demo.test${input}`, init));
  setLibraryService(new HttpLibraryService(DEMO_BASE, fetch));
  setJobsService(new HttpJobsService(DEMO_BASE, fetch));
  setUsageService(new HttpUsageService(DEMO_BASE, fetch));
  setEndpointSettingsService(new HttpEndpointSettingsService(DEMO_BASE, fetch));
  setDemoService(new HttpDemoService(DEMO_BASE, fetch));

  const post = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${DEMO_BASE}${path}`, { method: "POST" });
    if (!res.ok) throw new Error(`POST ${path} answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };
  return {
    library,
    fetch,
    situate: (id) => post(`/demo/situations/${encodeURIComponent(id)}`),
    reset: async () => void (await post("/demo/reset")),
    idle: () => library.runner.idle(),
  };
}
