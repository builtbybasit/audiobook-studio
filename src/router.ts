import { createRouter, createWebHistory } from "vue-router";
import LibraryView from "@/views/LibraryView.vue";

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
