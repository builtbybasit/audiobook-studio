// The seam the queue is read and driven through.
//
// The same arrangement as `@/services/library`: one HTTP implementation, chosen at startup, and
// `null` in demo mode — where the queue is the simulated one the jobs store runs itself. The jobs
// store asks `activeJobsService()` and takes one of two halves; no view knows which answered.
import type { Chapter, ExportItem, ExportSettings, Job, NarrationScope } from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { isBackend } from "@/services/mode";

/** Where the API answers. One spelling, because a download is a URL rather than a request. */
const API_BASE = "/api";

/** What queueing a scripting run came to: the jobs, and the chapters it left out and why. */
export interface ScriptingQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" }[];
  runId: number;
  /** the book's chapters as they now stand, with the queued ones marked */
  chapters: Chapter[];
}

/** What queueing a narration run came to: the same shape, with the reasons narration adds. */
export interface NarrationQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" | "unscripted" | "nothing" }[];
  runId: number;
  chapters: Chapter[];
}

/** What asking for retakes came to: the one job, the lines in it, and the lines left out and why. */
export interface RetakesQueued {
  /** null when nothing was queued */
  job: Job | null;
  queued: number[];
  skipped: { id: number; why: "missing" | "pending" }[];
  chapters: Chapter[];
}

/** What starting a build came to: the job that will run it, and the audiobook it is writing. */
export interface BuildQueued {
  job: Job;
  /** the entry as the server created it — building, with its files, version and what it replaces */
  export: ExportItem;
}

export interface JobsService {
  readonly simulated: boolean;
  /** Every job the server holds, oldest first. */
  list(): Promise<Job[]>;
  /** Stop a job: a queued one never starts, a running one is told to stop. */
  cancel(id: number): Promise<Job>;
  /** Take a finished job out of the history. */
  remove(id: number): Promise<void>;
  /** Clear the history; live jobs stay. Returns how many went. */
  clear(): Promise<number>;
  /** Script these chapters of a book, as one run. */
  scriptChapters(bookId: string, ids: number[]): Promise<ScriptingQueued>;
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
  readonly simulated = false;
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

  scriptChapters(bookId: string, ids: number[]): Promise<ScriptingQueued> {
    return this.http.post<ScriptingQueued>(`/books/${seg(bookId)}/chapters/script`, { ids });
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

/** The jobs service, or `null` when the queue is the simulated one the store runs itself. */
export function activeJobsService(): JobsService | null {
  if (service) return service;
  return isBackend ? (service = new HttpJobsService()) : null;
}

/** For tests and for wiring at startup. Set it before the jobs store is created. */
export function setJobsService(next: JobsService | null): void {
  service = next;
}
