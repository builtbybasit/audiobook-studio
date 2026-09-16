import { createRouter, createWebHistory, useRoute } from "vue-router";
import LibraryView from "@/views/LibraryView.vue";
import ScriptingView from "@/views/ScriptingView.vue";
import NarrationView from "@/views/NarrationView.vue";
import ExportView from "@/views/ExportView.vue";
import QueueView from "@/views/QueueView.vue";
import BookView from "@/views/BookView.vue";
import CastView from "@/views/CastView.vue";
import SearchView from "@/views/SearchView.vue";
import ContentsView from "@/views/ContentsView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/library" },
    { path: "/library", component: LibraryView },
    { path: "/queue", component: QueueView },
    // Lazy: the charting library only this page uses is a third of the bundle, and most sessions
    // never open it.
    { path: "/endpoints", component: () => import("@/views/EndpointsView.vue") },
    { path: "/book/:bookId", component: BookView },
    { path: "/book/:bookId/cast", component: CastView },
    { path: "/book/:bookId/contents", component: ContentsView },
    { path: "/book/:bookId/search", component: SearchView },
    { path: "/book/:bookId/scripting", component: ScriptingView },
    { path: "/book/:bookId/narration", component: NarrationView },
    { path: "/book/:bookId/export", component: ExportView },
  ],
});

/**
 * Route params arrive typed as `string | string[]`; every route above declares `:bookId` as a
 * single segment, so this narrows it once instead of at each call site.
 */
export function useBookId(): string {
  return String(useRoute().params.bookId);
}
