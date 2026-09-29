// What has been spent, as the server's ledger records it.
//
// The same arrangement as `@/services/jobs`: one HTTP implementation, answering at this tab's API.
// Every provider request a job sends is priced and appended to the server's ledger, so a book's
// total and an endpoint's Activity list are both sums over the same rows; nothing in the browser
// prices a request of its own.
import type { BookSpend, EndpointKind, RangeKey, RequestRecord } from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export interface UsageService {
  /** What one book has spent and what its unfinished work holds. */
  bookSpend(bookId: string): Promise<BookSpend>;
  /** One endpoint's settled requests inside `range`, newest first. */
  requests(kind: EndpointKind, id: string, range: RangeKey): Promise<RequestRecord[]>;
}

export class HttpUsageService implements UsageService {
  private readonly http: HttpClient;
  constructor(base = API_BASE, fetch?: FetchLike) {
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

/** The usage service: the one a test set, or the HTTP one for this tab's library. */
export function usageService(): UsageService {
  return (service ??= new HttpUsageService());
}

/** For tests and for wiring at startup. Set it before the jobs store is created. */
export function setUsageService(next: UsageService | null): void {
  service = next;
}
