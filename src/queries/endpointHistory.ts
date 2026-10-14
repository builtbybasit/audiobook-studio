// Every endpoint's past, from the server's ledger: charts, totals, the Activity list and recent
// rows. All filed under `keys.endpointRequests`, which the queue's poll invalidates. Totals are
// never summed here: the browser only holds a page of rows, so the server sums
// (`GET /api/endpoints/summary`) and filters (`GET /api/endpoints/requests`).
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

/** Latest rows read per endpoint: enough for latency history, cache rate and reasoning share. */
const RECENT = 2000;

/** How many rows the Activity list reads at a time. */
const PAGE = 100;

const joined = (list: readonly EndpointRef[]) => list.map((ep) => ep.key).join(",");

/** Includes the endpoints, so adding one rereads; `keys.endpointRequests` reaches it by prefix. */
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
 * Each endpoint's latest settled requests over the last week, by `key`, newest first; at most
 * `RECENT`, so never a total.
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
 * Each endpoint's server-summed summary over `range`, by `key`: chart buckets, totals, charge
 * since `today`, last settled. The previous summary stays on screen while a new range loads.
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

/** One endpoint's settled requests matching `filter`, newest first, a page at a time. */
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
