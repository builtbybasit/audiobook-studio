// Every endpoint's settled requests over the widest range, for the Endpoints page's charts, totals
// and Activity list.
//
// They are the rows of the server's ledger (`GET /api/endpoints/requests`): what a job actually
// sent, priced when it completed, with a simulated endpoint's rows marked `simulated`. The queue's
// poll invalidates them as jobs move, so the page's "spent today" follows a run as it goes.
//
// One pull of the widest range per endpoint; every shorter range is bucketed from it on the page.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { RequestRecord } from "@/types";
import { keys } from "@/queries/keys";
import type { EndpointDescriptor } from "@/services/endpoints";
import { usageService } from "@/services/usage";

/** What the ledger needs to name one endpoint's rows. */
export type EndpointRef = Pick<EndpointDescriptor, "key" | "id" | "kind">;

async function readHistories(list: EndpointRef[]): Promise<Record<string, RequestRecord[]>> {
  const svc = usageService();
  const rows = await Promise.all(list.map((ep) => svc.requests(ep.kind, ep.id, "7d")));
  return Object.fromEntries(list.map((ep, i) => [ep.key, rows[i]]));
}

/**
 * The key one list of endpoints' rows is filed under. The endpoints are in it, so adding or
 * removing one reads the list again; an invalidation of `keys.endpointRequests` reaches every such
 * entry by prefix.
 */
export const endpointHistoryKey = (list: readonly EndpointRef[]) =>
  [...keys.endpointRequests, list.map((ep) => ep.key).join(",")] as const;

/** The settled requests of each endpoint in `endpoints`, by its `key`, newest first. */
export function useEndpointHistory(endpoints: MaybeRefOrGetter<EndpointRef[]>) {
  const query = useQuery(() => ({
    key: endpointHistoryKey(toValue(endpoints)),
    staleTime: Infinity,
    query: () => readHistories(toValue(endpoints)),
  }));
  return {
    ...query,
    histories: computed(() => query.data.value ?? {}),
  };
}
