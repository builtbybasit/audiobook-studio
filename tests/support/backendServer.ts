// A server holding only what the test put there, the backend counterpart of `demoServer.ts`. The
// page's services point at a `testApi` over the real routes and a private database.
import type { FetchLike } from "@/services/http";
import {
  HttpEndpointSettingsService,
  setEndpointSettingsService,
} from "@/services/endpointSettings";
import { HttpJobsService, setJobsService } from "@/services/jobs";
import { HttpLibraryService, setLibraryService } from "@/services/library";
import { HttpUsageService, setUsageService } from "@/services/usage";
import { testApi, type TestApi, type TestApiOptions } from "./server";

/** Call before the stores under test are created: a store reads its service when first built. */
export function backendServer(options: TestApiOptions = {}): TestApi {
  const api = testApi(options);
  pointServicesAt(api.fetch);
  return api;
}

export interface ServiceWiring {
  /** Also load the endpoint config. Off, the endpoints store holds none (fine for queue suites). */
  endpoints?: boolean;
}

/**
 * Point the services at `fetch`, a server's own or a wrapped one. `null` restores the page's own,
 * which every other suite expects: the services are module state.
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
