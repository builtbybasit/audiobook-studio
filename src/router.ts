import { createRouter, createWebHistory } from "vue-router";
import LibraryView from "@/views/LibraryView.vue";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/library" },
    { path: "/library", component: LibraryView },
    { path: "/queue", component: () => import("@/views/QueueView.vue") },
    { path: "/endpoints", component: () => import("@/views/EndpointsView.vue") },
    // Every route declares `:bookId` as one segment, so `useBookId` can narrow it to a string.
    { path: "/book/:bookId", component: () => import("@/views/BookView.vue") },
    { path: "/book/:bookId/review", component: () => import("@/views/ReviewView.vue") },
    { path: "/book/:bookId/cast", component: () => import("@/views/CastView.vue") },
    { path: "/book/:bookId/contents", component: () => import("@/views/ContentsView.vue") },
    { path: "/book/:bookId/search", component: () => import("@/views/SearchView.vue") },
    { path: "/book/:bookId/scripting", component: () => import("@/views/ScriptingView.vue") },
    {
      path: "/book/:bookId/script-import",
      component: () => import("@/views/ScriptImportView.vue"),
    },
    { path: "/book/:bookId/narration", component: () => import("@/views/NarrationView.vue") },
    { path: "/book/:bookId/listen", component: () => import("@/views/ListenView.vue") },
    { path: "/book/:bookId/export", component: () => import("@/views/ExportView.vue") },
  ],
});

/**
 * The one place the library and endpoint config are fetched, so a pasted link or reload lands like
 * a click. A book the server lacks sends the person to the library rather than an empty review.
 */
router.beforeEach(async (to) => {
  const libraryStore = useLibraryStore();
  await Promise.all([libraryStore.load(), useEndpointsStore().load()]);
  const bookId = typeof to.params.bookId === "string" ? to.params.bookId : null;
  if (!bookId || libraryStore.chaptersOf(bookId).length) return true;
  return (await libraryStore.loadBook(bookId)) ? true : "/library";
});
