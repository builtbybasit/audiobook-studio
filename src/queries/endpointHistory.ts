// Every endpoint's settled requests over the widest range, for the Endpoints page's charts, totals
// and Activity list.
//
// With a server answering they are the rows of its ledger (`GET /api/endpoints/requests`): what a
// job actually sent, priced when it completed, with a fake provider's rows marked `simulated`. The
// queue's poll invalidates them as jobs move, so the page's "spent today" follows a run as it goes.
// In the demo they are the fixture service's invented week, generated once per world.
//
// One pull of the widest range per endpoint; every shorter range is bucketed from it on the page.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { RequestRecord } from "@/types";
import { keys } from "@/queries/keys";
import { endpointService, type EndpointDescriptor } from "@/services/endpoints";
import { activeUsageService } from "@/services/usage";

async function readHistories(list: EndpointDescriptor[]): Promise<Record<string, RequestRecord[]>> {
  const svc = activeUsageService();
  const rows = await Promise.all(
    list.map((ep) =>
      svc ? svc.requests(ep.kind, ep.id, "7d") : endpointService.history(ep, "7d"),
    ),
  );
  return Object.fromEntries(list.map((ep, i) => [ep.key, rows[i]]));
}

/** The settled requests of each endpoint in `endpoints`, by its `key`, newest first. */
export function useEndpointHistory(endpoints: MaybeRefOrGetter<EndpointDescriptor[]>) {
  const query = useQuery(() => ({
    // the endpoints are in the key, so adding or removing one reads the list again; an
    // invalidation of `keys.endpointRequests` reaches every such entry by prefix
    key: [
      ...keys.endpointRequests,
      toValue(endpoints)
        .map((ep) => ep.key)
        .join(","),
    ],
    staleTime: Infinity,
    query: () => readHistories(toValue(endpoints)),
  }));
  return {
    ...query,
    histories: computed(() => query.data.value ?? {}),
  };
}
