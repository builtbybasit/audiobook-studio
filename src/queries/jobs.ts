// The queue, read into the jobs store and polled while anything is live. One shared query for
// every reader. The server pushes nothing, so the poll is where a moved job is noticed: it
// invalidates whatever that job wrote (scripts, cast, history, exports, spending, endpoint live
// counts). It only says what to ask for again.
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { defineQuery, useQuery } from "@pinia/colada";

import type { Job } from "@/types";
import { staleMoved } from "@/queries/effects";
import { countsMoved } from "@/queries/speakerCounts";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { fetchBook } from "@/queries/library";
import { spendMoved } from "@/queries/spend";
import { jobsService } from "@/services/jobs";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { toastFailure } from "@/stores/toastFailure";

/** How often the server is asked again while something is queued or running. */
export const POLL_MS = 1500;

/** Finished jobs read at first, and how many more each "Show older" adds. */
export const HISTORY_STEP = 1000;

const live = (j: Job): boolean => j.status === "queued" || j.status === "running";
const narrating = (jobs: readonly Job[]): boolean =>
  jobs.some((j) => j.kind === "narration" && live(j));

const useJobsQuery = defineQuery(() => {
  const libraryStore = useLibraryStore();
  // part of what is asked but not of the key, so every reader of `keys.jobs` sees the longer list
  const history = ref(HISTORY_STEP);
  const query = useQuery({
    key: keys.jobs,
    query: () => jobsService().list(history.value),
    staleTime: POLL_MS,
    // the auto-refetch plugin reads this: poll while anything is live, and not otherwise
    autoRefetch: (state) => (state.data?.some(live) ? POLL_MS : false),
  });

  // a poll that finds the server down says so once, not every tick
  watch(
    () => !!query.error.value,
    (failing) => {
      if (failing) toastFailure("read the queue", query.error.value);
    },
  );

  // On the first read an unknown job is history, not change: reading everything it mentions
  // would be a startup fan-out that grows with the history.
  watch(query.data, (next, prev) => {
    if (!next || !prev) return;
    const before = new Map(prev.map((j) => [j.id, j]));
    // ids only grow: an unseen job below the newest seen is older history read in, not new work
    const newest = prev.reduce((n, j) => Math.max(n, j.id), 0);
    const books = new Set<string>();
    for (const j of next) {
      const was = before.get(j.id);
      const moved = was ? was.status !== j.status || was.progress !== j.progress : j.id > newest;
      if (!moved || !libraryStore.bookById(j.bookId)) continue;
      books.add(j.bookId);
      switch (j.kind) {
        case "scripting":
          if (j.status === "done" && was?.status !== "done") {
            if (j.chapterId != null) {
              useScriptsStore()._noteRescript(j.bookId, j.chapterId);
              void invalidate({ key: keys.chapterScript(j.bookId, j.chapterId) }, "all");
              void invalidate({ key: keys.chapterHistory(j.bookId, j.chapterId) }, "all");
            }
            void invalidate({ key: keys.cast(j.bookId) }, "all");
            void countsMoved(j.bookId);
          }
          break;
        // reread the chapter on each move, so clips show landing during the run
        case "narration":
          if (j.chapterId != null)
            void invalidate({ key: keys.chapterScript(j.bookId, j.chapterId) }, "all");
          break;
        // a check updates heard text and flags as it goes, so reread both on each move
        case "transcribe":
          if (j.chapterId != null) {
            void invalidate({ key: keys.chapterHeard(j.bookId, j.chapterId) }, "all");
            void invalidate({ key: keys.chapterScript(j.bookId, j.chapterId) }, "all");
          }
          break;
        // an export job writes its own row (progress, files, failure, or removal on cancel)
        case "export":
          void invalidate({ key: keys.exports(j.bookId) }, "all");
          break;
        // a Re-apply swaps clips' files anywhere in the book, so every chapter's script is read again
        case "effects":
          void invalidate({ key: keys.scripts(j.bookId) }, "all");
      }
      // a finished narration or Re-apply changes the book's old-sound count, and which of its
      // audiobooks are behind (the server's `changed`)
      if ((j.kind === "narration" || j.kind === "effects") && !live(j) && (!was || live(was))) {
        void staleMoved(j.bookId);
        void invalidate({ key: keys.exports(j.bookId) }, "all");
      }
    }
    // any move priced a request or released a reservation: reread the book's spending
    for (const id of books) {
      // through the book's query, so a slow read overtaken by the next tick's installs nothing
      void fetchBook(id).catch(() => {});
      void spendMoved(id);
    }
    // and each request it sent is a row on the Endpoints page
    if (books.size) void invalidate({ key: keys.endpointRequests });
    // while narration is live and once after, so the counts go back to zero
    if (narrating(next) || narrating(prev)) void invalidate({ key: keys.endpointLive });
  });

  /** Whether the server may hold finished jobs older than those read. */
  const older = computed(
    () => (query.data.value?.filter((j) => j.finishedAt).length ?? 0) >= history.value,
  );
  function showOlder(): void {
    history.value += HISTORY_STEP;
    void query.refetch();
  }
  return { ...query, older, showOlder };
});

/** The jobs of one book, or every job when no book is named. */
export function useBookJobs(bookId?: MaybeRefOrGetter<string | null | undefined>) {
  const jobsStore = useJobsStore();
  const query = useJobsQuery();
  const jobs = computed(() => {
    const id = toValue(bookId);
    return id ? jobsStore.jobs.filter((j) => j.bookId === id) : jobsStore.jobs;
  });
  return { ...query, jobs, active: computed(() => jobs.value.filter(live)) };
}

/** One job with its whole activity log (the list carries none), read again while it is live. */
export function useJob(id: MaybeRefOrGetter<number | null | undefined>) {
  return useQuery(() => {
    const jobId = toValue(id);
    return {
      key: [...keys.jobs, jobId ?? 0],
      query: () => jobsService().get(jobId!),
      enabled: jobId != null,
      staleTime: POLL_MS,
      autoRefetch: (state: { data?: Job }) =>
        state.data && !state.data.finishedAt ? POLL_MS : false,
    };
  });
}
