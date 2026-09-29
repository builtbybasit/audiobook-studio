// A server of the test's own, answering the page's services: what a backend tab talks to.
//
// `demoServer.ts` is the seeded demo; this is the other half, for a store test that wants a server
// holding only what the test put there. The page's services are pointed at a `testApi`, so a store
// under test asks it the way the browser asks `/api`, over the real routes and a private database.
import type { FetchLike } from "@/services/http";
import {
  HttpEndpointSettingsService,
  setEndpointSettingsService,
} from "@/services/endpointSettings";
import { HttpJobsService, setJobsService } from "@/services/jobs";
import { HttpLibraryService, setLibraryService } from "@/services/library";
import { HttpUsageService, setUsageService } from "@/services/usage";
import { testApi, type TestApi, type TestApiOptions } from "./server";

/**
 * Open a server of the test's own and point the page's services at it. Call it before the stores
 * under test are created: a store reads its service when its state is first built.
 */
export function backendServer(options: TestApiOptions = {}): TestApi {
  const api = testApi(options);
  pointServicesAt(api.fetch);
  return api;
}

export interface ServiceWiring {
  /**
   * The endpoint configuration read from the server too, as the app reads it. Off, the endpoints
   * store is never loaded and holds none, which is all a suite about the queue needs.
   */
  endpoints?: boolean;
}

/**
 * Point the library, jobs, usage and endpoint settings services at `fetch` — a server's own, or one
 * wrapped to watch what the stores ask it. `null` puts every one back to the page's own, which is
 * what every other suite expects to find: the services are module state.
 */
export function pointServicesAt(
  fetch: FetchLike | null,
  { endpoints = true }: ServiceWiring = {},
): void {
  setLibraryService(fetch && new HttpLibraryService("/api", fetch));
  setJobsService(fetch && new HttpJobsService("/api", fetch));
  setUsageService(fetch && new HttpUsageService("/api", fetch));
  setEndpointSettingsService(
    fetch && endpoints ? new HttpEndpointSettingsService("/api", fetch) : null,
  );
}
