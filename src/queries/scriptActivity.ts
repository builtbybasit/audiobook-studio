// Every scripting profile's past, for the Scripting page: its latest settled requests, which the
// health dots, the latency history, the last error, the cooldown and the estimate's observed cache
// rate and reasoning share are read off (by `@/lib/scriptActivity`), and its last seven days summed
// by the server over every request, which the "all books · 7 days" figures are. A run of a long book
// sends thousands of requests, so a total is never worked out from the latest rows.
//
// Both are the server's ledger, filed under `keys.endpointRequests` as the Endpoints page's reads
// are, so they are invalidated the same way: the queue's poll invalidates it whenever a job moves,
// and a scripting job moves as each of its requests settles.
import { useQueryCache } from "@pinia/colada";

import type { MetricTotals, RequestRecord } from "@/types";
import {
  endpointHistoryKey,
  useEndpointHistory,
  useEndpointSummaries,
  type EndpointRef,
} from "@/queries/endpointHistory";
import { useEndpointsStore } from "@/stores/endpoints";

/** A scripting profile as the ledger names it: the same `scripting:<id>` the Endpoints page keys by. */
const keyOf = (profileId: string): string => `scripting:${profileId}`;

/** The scripting profiles the store holds, in the store's order. */
const profileRefs = (): EndpointRef[] =>
  useEndpointsStore().profiles.map((p) => ({ key: keyOf(p.id), id: p.id, kind: "scripting" }));

/** Each scripting profile's settled requests, newest first; `rowsOf` a profile nothing has read yet is none. */
export function useScriptActivity() {
  const query = useEndpointHistory(profileRefs);
  return {
    ...query,
    rowsOf: (profileId: string): RequestRecord[] => query.histories.value[keyOf(profileId)] ?? [],
  };
}

/**
 * Each scripting profile's last seven days, summed by the server over every request in them;
 * `totalsOf` a profile nothing has read yet is null, which is not the same as nothing sent.
 */
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

/**
 * One profile's settled requests right now, for a store that needs them synchronously: whatever the
 * query cache already holds for the profiles the store lists. None when nothing has read them yet.
 */
export function scriptActivityNow(profileId: string): RequestRecord[] {
  const all = useQueryCache().getQueryData<Record<string, RequestRecord[]>>(
    endpointHistoryKey(profileRefs()),
  );
  return all?.[keyOf(profileId)] ?? [];
}
