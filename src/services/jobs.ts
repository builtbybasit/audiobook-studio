// The seam the queue is read and driven through.
//
// The same arrangement as `@/services/library`: one HTTP implementation, chosen at startup, and
// `null` in demo mode — where the queue is the simulated one the jobs store runs itself. The jobs
// store asks `activeJobsService()` and takes one of two halves; no view knows which answered.
import type { Chapter, Job } from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
import { isBackend } from "@/services/mode";

/** What queueing a scripting run came to: the jobs, and the chapters it left out and why. */
export interface ScriptingQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" }[];
  runId: number;
  /** the book's chapters as they now stand, with the queued ones marked */
  chapters: Chapter[];
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
}

export class HttpJobsService implements JobsService {
  readonly simulated = false;
  private readonly http: HttpClient;
  constructor(base = "/api", fetch?: FetchLike) {
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
