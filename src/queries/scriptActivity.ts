// Every scripting profile's settled requests, for the Scripting page's health dots, its activity
// figures and the estimate's observed cache rate.
//
// They are the same ledger rows the Endpoints page reads (`useEndpointHistory`), asked for over
// the scripting profiles alone, so they are invalidated the same way: the queue's poll invalidates
// `keys.endpointRequests` whenever a job moves, and a scripting job moves as each of its requests
// settles. The figures themselves are worked out from the rows by `@/lib/scriptActivity`.
import { useQueryCache } from "@pinia/colada";

import type { RequestRecord } from "@/types";
import {
  endpointHistoryKey,
  useEndpointHistory,
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
 * One profile's settled requests right now, for a store that needs them synchronously: whatever the
 * query cache already holds for the profiles the store lists. None when nothing has read them yet.
 */
export function scriptActivityNow(profileId: string): RequestRecord[] {
  const all = useQueryCache().getQueryData<Record<string, RequestRecord[]>>(
    endpointHistoryKey(profileRefs()),
  );
  return all?.[keyOf(profileId)] ?? [];
}
