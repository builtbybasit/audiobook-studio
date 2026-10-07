// Every endpoint's past, from the server's ledger: what the Endpoints page charts and totals, the
// requests its Activity list pages through, and the latest rows the Scripting page reads its
// figures from.
//
// They are the rows of the server's ledger: what a job actually sent, priced when it completed,
// with a simulated endpoint's rows marked `simulated`. Everything here is filed under
// `keys.endpointRequests`, which the queue's poll invalidates as jobs move, so the page's "spent
// today" follows a run as it goes.
//
// A total is never worked out from a list of rows here. A narration run sends thousands of
// requests, so any list the browser holds is a page of them; the summaries are summed by the server
// over every row in the range (`GET /api/endpoints/summary`), and the list is read a page at a time
// with its filters applied by the server (`GET /api/endpoints/requests`).
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useInfiniteQuery, useQuery } from "@pinia/colada";

import type { RangeKey, RequestRecord } from "@/types";
import { keys } from "@/queries/keys";
import type {
  EndpointDescriptor,
  EndpointSummary,
  RequestFilter,
  RequestPage,
} from "@/services/endpoints";
import { usageService } from "@/services/usage";

/** What the ledger needs to name one endpoint's rows. */
export type EndpointRef = Pick<EndpointDescriptor, "key" | "id" | "kind">;

/**
 * How many of an endpoint's latest rows `useEndpointHistory` reads: enough for every figure read
 * off the latest requests — the latency history, the observed cache rate, the reasoning share.
 */
const RECENT = 2000;

/** How many rows the Activity list reads at a time. */
const PAGE = 100;

const joined = (list: readonly EndpointRef[]) => list.map((ep) => ep.key).join(",");

/**
 * The key one list of endpoints' latest rows is filed under. The endpoints are in it, so adding or
 * removing one reads the list again; an invalidation of `keys.endpointRequests` reaches every such
 * entry by prefix.
 */
export const endpointHistoryKey = (list: readonly EndpointRef[]) =>
  [...keys.endpointRequests, joined(list)] as const;

async function readHistories(list: EndpointRef[]): Promise<Record<string, RequestRecord[]>> {
  const svc = usageService();
  const pages = await Promise.all(
    list.map((ep) => svc.requests(ep.kind, ep.id, { range: "7d" }, { limit: RECENT })),
  );
  return Object.fromEntries(list.map((ep, i) => [ep.key, pages[i].requests]));
}

/**
 * The latest settled requests of each endpoint in `endpoints` over the last week, by its `key`,
 * newest first — at most `RECENT` of them, so they are what the latest requests say, never a total.
 */
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

/**
 * Each endpoint's summary over `range` by its `key`: the buckets and totals of its charts, summed
 * by the server over every row, what it has been charged since `today` and when it last settled
 * anything. The previous summary stays on screen while a new range is read.
 */
export function useEndpointSummaries(
  endpoints: MaybeRefOrGetter<EndpointRef[]>,
  range: MaybeRefOrGetter<RangeKey>,
  today: MaybeRefOrGetter<number>,
) {
  const query = useQuery(() => {
    const list = toValue(endpoints);
    const r = toValue(range);
    const day = toValue(today);
    return {
      key: [...keys.endpointRequests, "summary", joined(list), r, day],
      staleTime: Infinity,
      placeholderData: (previous: Record<string, EndpointSummary> | undefined) => previous,
      query: async (): Promise<Record<string, EndpointSummary>> => {
        const svc = usageService();
        const all = await Promise.all(list.map((ep) => svc.summary(ep.kind, ep.id, r, day)));
        return Object.fromEntries(list.map((ep, i) => [ep.key, all[i]]));
      },
    };
  });
  return {
    ...query,
    summaries: computed<Record<string, EndpointSummary>>(() => query.data.value ?? {}),
  };
}

/**
 * One endpoint's settled requests matching `filter`, newest first, a page at a time: `loadNextPage`
 * reads the next one, and a refresh reads every page already shown again.
 */
export function useEndpointRequests(
  endpoint: MaybeRefOrGetter<EndpointRef | null>,
  filter: MaybeRefOrGetter<RequestFilter>,
) {
  const query = useInfiniteQuery(() => {
    const ep = toValue(endpoint);
    const f = toValue(filter);
    const asked: RequestFilter = {
      range: f.range,
      window: f.window,
      status: f.status,
      bookId: f.bookId,
      search: f.search?.trim(),
    };
    return {
      key: [...keys.endpointRequests, "list", ep?.key ?? "", JSON.stringify(asked)],
      staleTime: Infinity,
      enabled: !!ep,
      initialPageParam: null as string | null,
      getNextPageParam: (last: RequestPage) => last.next,
      query: ({ pageParam }: { pageParam: string | null }) =>
        usageService().requests(ep!.kind, ep!.id, asked, { before: pageParam, limit: PAGE }),
    };
  });
  return {
    ...query,
    rows: computed(() => query.data.value?.pages.flatMap((p) => p.requests) ?? []),
    /** how many requests match the filter, over every page */
    total: computed(() => query.data.value?.pages[0]?.total ?? 0),
  };
}
