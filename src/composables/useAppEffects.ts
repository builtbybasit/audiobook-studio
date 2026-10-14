// What the app does while open, whichever page shows: shell reads, the open book from the address,
// theme and title, expression audio, and word when a book's run finishes. App.vue calls it once.
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useBookJobs, useBookSpend } from "@/queries";
import { isDemo } from "@/services/mode";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useUiStore } from "@/stores/ui";

export function useAppEffects(): void {
  const endpointsStore = useEndpointsStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  const narrationStore = useNarrationStore();
  const uiStore = useUiStore();
  const route = useRoute();
  const router = useRouter();

  // the shell reads the queue while the app is open, which keeps it polling while a job is live
  useBookJobs();
  // …and the open book's spending, which every page of it sets against the budget
  useBookSpend(() => uiStore.currentBookId);
  watch(
    () =>
      endpointsStore.endpoints.map((e) =>
        JSON.stringify([e.id, e.model, e.baseUrl, e.expressions]),
      ),
    () => narrationStore.refreshExpressionAudio(),
  );

  watch(
    () => route.params.bookId,
    (id) => {
      // a book still in its contents review is not on the shelf yet, so it is not the open book
      if (id && !libraryStore.bookById(String(id))?.importing) uiStore.currentBookId = String(id);
    },
    { immediate: true },
  );
  watch(
    () => uiStore.dark,
    (d) => document.documentElement.classList.toggle("dark", d),
    { immediate: true },
  );
  watch(
    () => jobsStore.activeJobs.length,
    (n) => {
      // the mode is the tab's, so the tab says which one it is
      document.title =
        (n ? `(${n}) ` : "") + (isDemo ? "Audiobook Studio · demo" : "Audiobook Studio");
    },
    { immediate: true },
  );

  // a book's run finished (it had active jobs, now none) → toast, and a browser notification if
  // enabled
  const activeByBook = computed(() => {
    const m: Record<string, number> = {};
    for (const j of jobsStore.activeJobs) m[j.bookId] = (m[j.bookId] ?? 0) + 1;
    return m;
  });
  watch(activeByBook, (now, before) => {
    for (const id of Object.keys(before ?? {})) {
      if (now[id]) continue;
      const b = libraryStore.bookById(id);
      if (!b) continue;
      const recent = jobsStore.jobs.filter(
        (j) => j.bookId === id && j.finishedAt && Date.now() - j.finishedAt < 5 * 60000,
      );
      const failed = recent.filter((j) => j.status === "failed").length;
      const cancelled = recent.filter((j) => j.status === "cancelled").length;
      if (recent.length && recent.every((j) => j.status === "cancelled")) continue;
      const desc = `${recent.length - failed - cancelled} done${failed ? ` · ${failed} failed` : ""}`;
      uiStore.toast(`${b.title}: run finished`, {
        kind: failed ? "warn" : "success",
        description: desc,
        action: {
          label: failed ? "See what failed" : "Open queue",
          run: () => router.push("/queue"),
        },
      });
      if (
        uiStore.notify &&
        "Notification" in window &&
        Notification.permission === "granted" &&
        document.hidden
      )
        new Notification("Audiobook Studio", { body: `${b.title}: run finished · ${desc}` });
    }
  });
}
