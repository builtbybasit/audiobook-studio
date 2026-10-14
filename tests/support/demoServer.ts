// The demo library in-process, for store tests that want the seeded world: the server's own
// `openLibrary` over an in-memory database, every endpoint simulated, with the page's services
// pointed at it. Providers get a `fetch` that fails the test.
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
import { ffmpegEncoders } from "~/providers/ffmpegEncoder";
import { collectingLogger, tempAudioDir, tempExportDir, tempVoiceDir } from "./server";

/** The demo's endpoints are simulated and must never reach the network. */
const noNetwork = (async (url: string) => {
  throw new Error(`the demo sent a request to ${url}`);
}) as unknown as typeof globalThis.fetch;

export interface DemoServer {
  library: Library;
  /** the page's `fetch`, answered by the demo library */
  fetch: FetchLike;
  /** As the Demo drawer sends it. A situation rebuilds the demo, so a `reset()` first is wasted. */
  situate(id: string): Promise<{ note: string; open: string }>;
  /** `POST /demo/api/demo/reset` */
  reset(): Promise<void>;
  /** let every job the demo's queue holds finish */
  idle(): Promise<void>;
  /** Stop the queue so situation runs hold still between reads. Reset or situate restarts it. */
  hold(): Promise<void>;
}

/** Call before the stores under test are created: a store reads its service when first built. */
export async function demoServer(): Promise<DemoServer> {
  const library = openLibrary({
    name: "demo",
    base: DEMO_BASE,
    databaseUrl: ":memory:",
    audioDir: tempAudioDir(),
    exportDir: tempExportDir(),
    voiceDir: tempVoiceDir(),
    encoders: ffmpegEncoders(),
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
    hold: () => library.runner.stop(),
  };
}
