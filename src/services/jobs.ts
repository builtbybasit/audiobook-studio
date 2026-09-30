// The seam the queue is read and driven through.
//
// The same arrangement as `@/services/library`: one HTTP implementation, asking the library this
// tab is on (`API_BASE`) — yours, or the demo's — unless a test set another. The jobs store asks
// `jobsService()`; no view knows which answered.
import type {
  BuildQueued,
  ExportSettings,
  Job,
  NarrationQueued,
  NarrationScope,
  RetakesQueued,
  ScriptingQueued,
} from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { API_BASE } from "@/services/mode";

export interface JobsService {
  /** Every job the server holds, oldest first. */
  list(): Promise<Job[]>;
  /** Stop a job: a queued one never starts, a running one is told to stop. */
  cancel(id: number): Promise<Job>;
  /** Take a finished job out of the history. */
  remove(id: number): Promise<void>;
  /** Clear the history; live jobs stay. Returns how many went. */
  clear(): Promise<number>;
  /**
   * Script these chapters of a book, as one run, cutting each into the requests `profile` allows —
   * the scripting profile chosen on the page, which the server reads from the endpoints saved to it.
   */
  scriptChapters(bookId: string, ids: number[], profile?: string): Promise<ScriptingQueued>;
  /** Narrate these chapters of a book, as one run, at the scope named. */
  narrateChapters(bookId: string, ids: number[], scope: NarrationScope): Promise<NarrationQueued>;
  /** Render these lines of a chapter again, each beside the clip it may replace, as one job. */
  retakeLines(bookId: string, chapterId: number, ids: number[]): Promise<RetakesQueued>;
  /** Stitch these chapters of a book into one audiobook, as one job. */
  buildExport(
    bookId: string,
    ids: number[],
    settings: ExportSettings,
    updates?: number | null,
  ): Promise<BuildQueued>;
}

export class HttpJobsService implements JobsService {
  private readonly http: HttpClient;
  constructor(base = API_BASE, fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  async list(): Promise<Job[]> {
    return (await this.http.get<{ jobs: Job[] }>("/jobs")).jobs;
  }

  async cancel(id: number): Promise<Job> {
    return (await this.http.post<{ job: Job }>(`/jobs/${id}/cancel`)).job;
  }

  async remove(id: number): Promise<void> {
    await this.http.delete(`/jobs/${id}`);
  }

  async clear(): Promise<number> {
    return (await this.http.post<{ removed: number }>("/jobs/clear")).removed;
  }

  scriptChapters(bookId: string, ids: number[], profile?: string): Promise<ScriptingQueued> {
    return this.http.post<ScriptingQueued>(`/books/${seg(bookId)}/chapters/script`, {
      ids,
      ...(profile ? { profile } : {}),
    });
  }

  narrateChapters(bookId: string, ids: number[], scope: NarrationScope): Promise<NarrationQueued> {
    return this.http.post<NarrationQueued>(`/books/${seg(bookId)}/chapters/narrate`, {
      ids,
      scope,
    });
  }

  retakeLines(bookId: string, chapterId: number, ids: number[]): Promise<RetakesQueued> {
    return this.http.post<RetakesQueued>(`/books/${seg(bookId)}/chapters/${chapterId}/retakes`, {
      ids,
    });
  }

  buildExport(
    bookId: string,
    ids: number[],
    settings: ExportSettings,
    updates?: number | null,
  ): Promise<BuildQueued> {
    return this.http.post<BuildQueued>(`/books/${seg(bookId)}/exports`, { ids, settings, updates });
  }
}

/**
 * Where one built file of an export is downloaded from. `position` is the file's place in
 * `export.files`, which is what the route addresses: a name would have to survive a rename and
 * whatever a filesystem does to it, and the order is the audiobook's own.
 *
 * It is here rather than in a view so nothing hand-builds an API path; the browser follows it, so
 * it is a URL and not a request this client makes.
 */
export function exportFileUrl(bookId: string, exportId: number, position: number): string {
  return `${API_BASE}/books/${seg(bookId)}/exports/${exportId}/files/${position}`;
}

let service: JobsService | null = null;

/** The jobs service: the one a test set, or the HTTP one for this tab's library. */
export function jobsService(): JobsService {
  return (service ??= new HttpJobsService());
}

/** For tests and for wiring at startup. Set it before the jobs store is created. */
export function setJobsService(next: JobsService | null): void {
  service = next;
}
