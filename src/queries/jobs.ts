// The queue, read into the jobs store and kept moving while anything is live.
//
// One query for every job, shared by whoever asks (`defineQuery`): the shell's indicator, the
// Queue page and a book's overview all read the same poll rather than three. With a server
// answering it polls while a job is queued or running and goes quiet when the queue does; each
// read is installed into the jobs store, which every page reads. The seeded demo's queue is the
// store's own, driven by the simulators, and the query only answers with it.
//
// A job that moved is a chapter that moved. The server does not push events, so the poll is where
// a change is noticed: a job whose status or progress changed has its book read again, a
// scripting job that finished has its chapter's script, history and the book's cast invalidated —
// the run wrote all three on the server — and an export job has its book's audiobooks read again,
// because the row it is writing is one of them; and every move has the book's spending read again,
// since a request was priced or a reservation let go. Nothing here decides what a chapter holds;
// it only says what to ask for again.
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { defineQuery, useQuery } from "@pinia/colada";

import type { Job } from "@/types";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { spendMoved } from "@/queries/spend";
import { activeJobsService } from "@/services/jobs";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

/** How often the server is asked again while something is queued or running. */
export const POLL_MS = 1500;

const live = (j: Job): boolean => j.status === "queued" || j.status === "running";

async function readJobs(): Promise<Job[]> {
  const jobsStore = useJobsStore();
  const svc = activeJobsService();
  if (!svc) return jobsStore.jobs;
  const jobs = await svc.list();
  jobsStore._install(jobs);
  return jobs;
}

const useJobsQuery = defineQuery(() => {
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  const query = useQuery({
    key: keys.jobs,
    query: readJobs,
    staleTime: POLL_MS,
    // the auto-refetch plugin reads this: poll while anything is live, and not otherwise
    autoRefetch: (state) => (activeJobsService() && state.data?.some(live) ? POLL_MS : false),
  });

  // A poll that finds the server down says so once, not every tick until it is back.
  watch(
    () => !!query.error.value,
    (failing) => {
      if (failing && activeJobsService()) jobsStore._failed("read the queue", query.error.value);
    },
  );

  // On the first read a job the store has never heard of is history, not change — reading every
  // book and every finished script the server mentions would be a startup fan-out that grows
  // with the history. From then on a job that moved has its book read again, and one that just
  // finished scripting has what it wrote asked for again.
  watch(query.data, (next, prev) => {
    if (!activeJobsService() || !next || !prev) return;
    const before = new Map(prev.map((j) => [j.id, j]));
    const books = new Set<string>();
    for (const j of next) {
      const was = before.get(j.id);
      const moved = !was || was.status !== j.status || was.progress !== j.progress;
      if (!moved || !libraryStore.bookById(j.bookId)) continue;
      books.add(j.bookId);
      if (j.kind === "scripting" && j.status === "done" && was?.status !== "done") {
        if (j.chapterId != null) {
          useScriptsStore()._noteRescript(j.bookId, j.chapterId);
          void invalidate({ key: keys.chapterScript(j.bookId, j.chapterId) }, "all");
          void invalidate({ key: keys.chapterHistory(j.bookId, j.chapterId) }, "all");
        }
        void invalidate({ key: keys.cast(j.bookId) }, "all");
      }
      // a narration job writes clips as they land, and every clip is on a line of the script: the
      // chapter is read again on each move, so the Narration page shows them landing rather than
      // waiting for the run to finish
      if (j.kind === "narration" && j.chapterId != null)
        void invalidate({ key: keys.chapterScript(j.bookId, j.chapterId) }, "all");
      // an export job is writing the export row it was started with — its progress, then the files
      // and the size it finished with, or the failure, or nothing at all, since a cancelled build
      // takes its row with it. Every move of one is therefore a change to the Audiobooks tab.
      if (j.kind === "export") void invalidate({ key: keys.exports(j.bookId) }, "all");
    }
    // a job that moved sent a request, finished or let go of what it held: the book's spending is
    // read again, the way its chapters are
    for (const id of books) {
      void libraryStore.loadBook(id);
      void spendMoved(id);
    }
    // and each request it sent is a row on the Endpoints page
    if (books.size) void invalidate({ key: keys.endpointRequests });
  });

  return query;
});

/**
 * The jobs of one book, or every job when no book is named.
 *
 * `jobs` reads the store, so it is the same list the simulators move in the demo and the poll
 * installs with a server answering.
 */
export function useBookJobs(bookId?: MaybeRefOrGetter<string | null | undefined>) {
  const jobsStore = useJobsStore();
  const query = useJobsQuery();
  const jobs = computed(() => {
    const id = toValue(bookId);
    return id ? jobsStore.jobs.filter((j) => j.bookId === id) : jobsStore.jobs;
  });
  return { ...query, jobs, active: computed(() => jobs.value.filter(live)) };
}
