// What each speech endpoint is doing now, as the server's speech gate sees it
// (`GET /api/endpoints/live`): lines out and waiting, rate limits, cooldown end. Each read puts the
// limits and cooldown on the endpoints (`_installLive`); the counts stay here. It does not poll:
// the queue's poll invalidates it while narration is live and once after.
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

/** Live telemetry for every speech endpoint. Failures are silent: the queue's poll says so. */
export const useEndpointLive = defineQuery(() =>
  useQuery({ key: keys.endpointLive, query: readLive, staleTime: POLL_MS }),
);
