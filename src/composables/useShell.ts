// The app shell's view of the open book: what the header's book selector, the tab row under it
// and the sidebar rail show. Read-only over the stores. The counts come from `bookFacts`, so
// the shelf card, the overview and the shell say the same thing about a book.
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

import { computed } from "vue";
import { useRoute } from "vue-router";
import { keyring } from "@/lib/keyring";
import { endpointErrors, unifyEndpoint, unifyProfile } from "@/lib/endpoints";
import { bookFacts } from "@/views/library/bookFacts";
import { reviewCount } from "@/views/review/inbox";

/** The pages under /book/:id besides the overview, as their path segment. */
export const BOOK_PAGES = [
  "contents",
  "review",
  "cast",
  "search",
  "scripting",
  "narration",
  "export",
] as const;
export type BookPage = (typeof BOOK_PAGES)[number];

const isBookPage = (k: string): k is BookPage => (BOOK_PAGES as readonly string[]).includes(k);

export function useShell() {
  const castStore = useCastStore();
  const endpointsStore = useEndpointsStore();
  const jobsStore = useJobsStore();
  const libraryStore = useLibraryStore();
  const route = useRoute();

  const book = computed(() => libraryStore.book);
  const facts = computed(() => (book.value ? bookFacts(book.value.id) : null));
  /** decisions waiting on the open book — verdicts, not work */
  const waiting = computed(() => (book.value ? reviewCount(book.value.id) : 0));
  const castCount = computed(() => (book.value ? castStore.charactersOf(book.value.id).length : 0));
  /** "overview" on /book/:id, else the last path segment: a book page or an app page */
  const activeKey = computed(() =>
    route.path.match(/^\/book\/[^/]+$/) ? "overview" : (route.path.split("/").pop() ?? ""),
  );
  /** on one of the open book's own pages, rather than Library, Queue or Endpoints */
  const onBookPage = computed(() => activeKey.value === "overview" || isBookPage(activeKey.value));
  const activeJobs = computed(() => jobsStore.activeJobs.length);
  const etaMinutes = computed(() =>
    jobsStore.eta ? Math.max(1, Math.round(jobsStore.eta.seconds / 60)) : 0,
  );
  /** enabled endpoints that can't currently run: no key, or settings that don't validate */
  const endpointsNeedingAttention = computed(
    () =>
      [
        ...endpointsStore.profiles.map(unifyProfile),
        ...endpointsStore.endpoints.map(unifyEndpoint),
      ].filter(
        (u) => u.enabled && ((u.needsKey && !keyring.has(u.slot)) || endpointErrors(u).length > 0),
      ).length,
  );
  /** A link to another book that lands on the page you are already on, so switching keeps your place. */
  const switchTo = (id: string): string =>
    isBookPage(activeKey.value) ? `/book/${id}/${activeKey.value}` : `/book/${id}`;
  /** where a switch lands, in a word */
  const pageName = computed(() => (isBookPage(activeKey.value) ? activeKey.value : "overview"));
  const others = computed(() => libraryStore.shelved.filter((b) => b.id !== book.value?.id));

  return {
    book,
    facts,
    waiting,
    castCount,
    activeKey,
    onBookPage,
    activeJobs,
    etaMinutes,
    endpointsNeedingAttention,
    switchTo,
    pageName,
    others,
  };
}
