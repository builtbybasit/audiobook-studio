// What has been spent, as the server's ledger records it.
//
// The same arrangement as `@/services/jobs`: one HTTP implementation, chosen at startup, and `null`
// in demo mode — where spending is the session's own ledger in `@/stores/usage` and the Endpoints
// page's history is the fixture's invented week. With a server answering, every provider request
// a job sends is priced and appended there, so a book's total and an endpoint's Activity list are
// both sums over the same rows; nothing in the browser prices a request of its own.
import type { BookSpend, EndpointKind, RangeKey, RequestRecord } from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { isBackend } from "@/services/mode";

export interface UsageService {
  /** What one book has spent and what its unfinished work holds. */
  bookSpend(bookId: string): Promise<BookSpend>;
  /** One endpoint's settled requests inside `range`, newest first. */
  requests(kind: EndpointKind, id: string, range: RangeKey): Promise<RequestRecord[]>;
}

export class HttpUsageService implements UsageService {
  private readonly http: HttpClient;
  constructor(base = "/api", fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  async bookSpend(bookId: string): Promise<BookSpend> {
    return (await this.http.get<{ spend: BookSpend }>(`/books/${seg(bookId)}/spend`)).spend;
  }

  async requests(kind: EndpointKind, id: string, range: RangeKey): Promise<RequestRecord[]> {
    const q = new URLSearchParams({ kind, id, range });
    return (await this.http.get<{ requests: RequestRecord[] }>(`/endpoints/requests?${q}`))
      .requests;
  }
}

let service: UsageService | null = null;

/** The usage service, or `null` when spending is the demo's own ledger. */
export function activeUsageService(): UsageService | null {
  if (service) return service;
  return isBackend ? (service = new HttpUsageService()) : null;
}

/** For tests and for wiring at startup. Set it before the jobs store is created. */
export function setUsageService(next: UsageService | null): void {
  service = next;
}
