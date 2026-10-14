// Every scripting profile's past, for the Scripting page: latest settled requests (read by
// `@/lib/scriptActivity` for health, latency, cooldown, cache rate, reasoning share) and seven-day
// totals summed by the server. Under `keys.endpointRequests`, so the queue's poll invalidates it.
import { useQueryCache } from "@pinia/colada";

import type { MetricTotals, RequestRecord } from "@/types";
import {
  endpointHistoryKey,
  useEndpointHistory,
  useEndpointSummaries,
  type EndpointRef,
} from "@/queries/endpointHistory";
import { useEndpointsStore } from "@/stores/endpoints";

/** The ledger's name for a profile: the same `scripting:<id>` the Endpoints page keys by. */
const keyOf = (profileId: string): string => `scripting:${profileId}`;

const profileRefs = (): EndpointRef[] =>
  useEndpointsStore().profiles.map((p) => ({ key: keyOf(p.id), id: p.id, kind: "scripting" }));

/** Each scripting profile's settled requests, newest first; none for an unread profile. */
export function useScriptActivity() {
  const query = useEndpointHistory(profileRefs);
  return {
    ...query,
    rowsOf: (profileId: string): RequestRecord[] => query.histories.value[keyOf(profileId)] ?? [],
  };
}

/** Each profile's server-summed last seven days; null when unread, which is not nothing sent. */
export function useScriptTotals() {
  // the summary also says what was spent since this midnight, which nothing here reads
  const midnight = new Date().setHours(0, 0, 0, 0);
  const query = useEndpointSummaries(profileRefs, "7d", midnight);
  return {
    ...query,
    totalsOf: (profileId: string): MetricTotals | null =>
      query.summaries.value[keyOf(profileId)]?.series.totals ?? null,
  };
}

/** One profile's cached settled requests, for synchronous store callers; none when unread. */
export function scriptActivityNow(profileId: string): RequestRecord[] {
  const all = useQueryCache().getQueryData<Record<string, RequestRecord[]>>(
    endpointHistoryKey(profileRefs()),
  );
  return all?.[keyOf(profileId)] ?? [];
}
