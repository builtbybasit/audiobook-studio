// The seam the queue is read and driven through, as `@/services/library` is for books.
import type {
  BuildQueued,
  CheckQueued,
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
  /** Live jobs and the `history` latest finished, oldest first; a failed one keeps its first error. */
  list(history?: number): Promise<Job[]>;
  /** With its whole activity log. */
  get(id: number): Promise<Job>;
  /** A queued job never starts; a running one is told to stop. */
  cancel(id: number): Promise<Job>;
  /** In the order given. Returns the ids that were live and now stop. */
  cancelMany(ids: number[]): Promise<number[]>;
  /** Move queued jobs ahead of the rest, in their own order. Returns the ids that moved. */
  runNext(ids: number[]): Promise<number[]>;
  remove(id: number): Promise<void>;
  /** Clear the history; live jobs stay. Returns how many went. */
  clear(): Promise<number>;
  /** As one run, cut into the requests `profile` (the saved scripting endpoint) allows. */
  scriptChapters(bookId: string, ids: number[], profile?: string): Promise<ScriptingQueued>;
  narrateChapters(bookId: string, ids: number[], scope: NarrationScope): Promise<NarrationQueued>;
  /** On the first enabled transcriber, as one run; `again` also re-hears clips already heard. */
  checkChapters(bookId: string, ids: number[], again?: boolean): Promise<CheckQueued>;
  /** Each line renders beside the clip it may replace, as one job. */
  retakeLines(bookId: string, chapterId: number, ids: number[]): Promise<RetakesQueued>;
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

  async list(history?: number): Promise<Job[]> {
    const query = history === undefined ? "" : `?history=${history}`;
    return (await this.http.get<{ jobs: Job[] }>(`/jobs${query}`)).jobs;
  }

  async get(id: number): Promise<Job> {
    return (await this.http.get<{ job: Job }>(`/jobs/${id}`)).job;
  }

  async cancel(id: number): Promise<Job> {
    return (await this.http.post<{ job: Job }>(`/jobs/${id}/cancel`)).job;
  }

  async cancelMany(ids: number[]): Promise<number[]> {
    return (await this.http.post<{ cancelled: number[] }>("/jobs/cancel", { ids })).cancelled;
  }

  async runNext(ids: number[]): Promise<number[]> {
    return (await this.http.post<{ moved: number[] }>("/jobs/run-next", { ids })).moved;
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

  checkChapters(bookId: string, ids: number[], again = false): Promise<CheckQueued> {
    return this.http.post<CheckQueued>(`/books/${seg(bookId)}/chapters/check`, {
      ids,
      ...(again ? { again } : {}),
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
 * `position` is the file's place in `export.files`: the order is the audiobook's own, while a name
 * would have to survive renames and filesystems. A URL the browser follows, not a request.
 */
export function exportFileUrl(bookId: string, exportId: number, position: number): string {
  return `${API_BASE}/books/${seg(bookId)}/exports/${exportId}/files/${position}`;
}

let service: JobsService | null = null;

/** The one a test set, or the HTTP one for this tab's library. */
export function jobsService(): JobsService {
  return (service ??= new HttpJobsService());
}

/** For tests and startup wiring. Set it before the jobs store is created. */
export function setJobsService(next: JobsService | null): void {
  service = next;
}
