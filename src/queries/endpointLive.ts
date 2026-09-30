// What each speech endpoint is doing right now, as the server's speech gate sees it.
//
// Narration goes out through one gate per process that holds each endpoint to its concurrency, its
// pause and the cooldown after a rate limit, and `GET /api/endpoints/live` says what it holds:
// lines out, lines waiting, rate limits met and when the cooldown ends. Each read puts the cooldown
// and the rate limits on the endpoints in the endpoints store (`_installLive`); the counts stay
// here, where the store's `live` reads them for the Endpoints and Queue pages.
//
// The query does not poll on its own. The queue's poll (`@/queries/jobs`) is already running while
// anything is live, and it invalidates this one on every read that finds narration queued or
// running, and on the read that finds the last of it finished — so a page that shows it follows a
// run at the queue's pace, sees the counts fall back to nothing at the end, and asks nothing while
// the queue is idle. A page that does not show it asks nothing either: an invalidation only reads
// again what a page is reading.
import { defineQuery, useQuery } from "@pinia/colada";

import type { EndpointLive } from "@/types";
import { keys } from "@/queries/keys";
import { POLL_MS } from "@/queries/jobs";
import { endpointSettingsService } from "@/services/endpointSettings";
import { useEndpointsStore } from "@/stores/endpoints";

async function readLive(): Promise<Record<string, EndpointLive>> {
  const live = await endpointSettingsService().live();
  useEndpointsStore()._installLive(live);
  return live;
}

/**
 * The server's live telemetry for every speech endpoint. A failed
 * read is not said: the queue's poll against the same server says so already, and the page keeps
 * the last counts it had until the next read.
 */
export const useEndpointLive = defineQuery(() =>
  useQuery({ key: keys.endpointLive, query: readLive, staleTime: POLL_MS }),
);
