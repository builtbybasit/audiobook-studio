import { createRouter, createWebHistory } from "vue-router";
import LibraryView from "@/views/LibraryView.vue";
import { useLibraryStore } from "@/stores/library";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/library" },
    { path: "/library", component: LibraryView },
    { path: "/queue", component: () => import("@/views/QueueView.vue") },
    { path: "/endpoints", component: () => import("@/views/EndpointsView.vue") },
    // Every route below declares `:bookId` as a single segment, never a repeatable one — that is
    // what lets `useBookId` narrow the param to a plain string.
    { path: "/book/:bookId", component: () => import("@/views/BookView.vue") },
    { path: "/book/:bookId/review", component: () => import("@/views/ReviewView.vue") },
    { path: "/book/:bookId/cast", component: () => import("@/views/CastView.vue") },
    { path: "/book/:bookId/contents", component: () => import("@/views/ContentsView.vue") },
    { path: "/book/:bookId/search", component: () => import("@/views/SearchView.vue") },
    { path: "/book/:bookId/scripting", component: () => import("@/views/ScriptingView.vue") },
    { path: "/book/:bookId/narration", component: () => import("@/views/NarrationView.vue") },
    { path: "/book/:bookId/export", component: () => import("@/views/ExportView.vue") },
  ],
});

/**
 * With a server answering, have the library before the page that reads it.
 *
 * This is the one place a book is fetched, so a link pasted into a new tab and a reload land on
 * the same page as a click does. The seeded world is already in the store and never comes here.
 * A book the server does not have sends the person to the library rather than to an empty review.
 */
router.beforeEach(async (to) => {
  const libraryStore = useLibraryStore();
  if (!libraryStore._service()) return true;
  await libraryStore.load();
  const bookId = typeof to.params.bookId === "string" ? to.params.bookId : null;
  if (!bookId || libraryStore.chaptersOf(bookId).length) return true;
  return (await libraryStore.loadBook(bookId)) ? true : "/library";
});
