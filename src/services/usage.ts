// Spending, read from the server's ledger: every provider request a job sends is priced there, so
// book totals, endpoint summaries and Activity all read the same rows. The browser prices nothing.
import type { BookSpend, EndpointKind, RangeKey } from "@/types";
import type { EndpointSummary, RequestFilter, RequestPage } from "@/services/endpoints";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export interface UsageService {
  /** What one book has spent and what its unfinished work holds. */
  bookSpend(bookId: string): Promise<BookSpend>;
  /** One endpoint's past in `range`, summed over every row; "today" counts from `today`. */
  summary(kind: EndpointKind, id: string, range: RangeKey, today: number): Promise<EndpointSummary>;
  /** Settled requests matching `filter`, newest first; `before` is the previous page's `next`. */
  requests(
    kind: EndpointKind,
    id: string,
    filter: RequestFilter,
    page?: { before?: string | null; limit?: number },
  ): Promise<RequestPage>;
}

export class HttpUsageService implements UsageService {
  private readonly http: HttpClient;
  constructor(base = API_BASE, fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  async bookSpend(bookId: string): Promise<BookSpend> {
    return (await this.http.get<{ spend: BookSpend }>(`/books/${seg(bookId)}/spend`)).spend;
  }

  async summary(
    kind: EndpointKind,
    id: string,
    range: RangeKey,
    today: number,
  ): Promise<EndpointSummary> {
    const q = new URLSearchParams({ kind, id, range, today: String(today) });
    return (await this.http.get<{ summary: EndpointSummary }>(`/endpoints/summary?${q}`)).summary;
  }

  requests(
    kind: EndpointKind,
    id: string,
    filter: RequestFilter,
    page: { before?: string | null; limit?: number } = {},
  ): Promise<RequestPage> {
    const q = new URLSearchParams({ kind, id, range: filter.range });
    if (filter.window) {
      q.set("from", String(filter.window.from));
      q.set("to", String(filter.window.to));
    }
    if (filter.status && filter.status !== "all") q.set("status", filter.status);
    if (filter.bookId) q.set("bookId", filter.bookId);
    if (filter.search?.trim()) q.set("search", filter.search.trim());
    if (page.before) q.set("before", page.before);
    if (page.limit) q.set("limit", String(page.limit));
    return this.http.get<RequestPage>(`/endpoints/requests?${q}`);
  }
}

let service: UsageService | null = null;

/** The one a test set, or the HTTP one for this tab's library. */
export function usageService(): UsageService {
  return (service ??= new HttpUsageService());
}

/** For tests and startup wiring. Set it before the jobs store is created. */
export function setUsageService(next: UsageService | null): void {
  service = next;
}
