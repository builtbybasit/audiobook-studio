// Which book the page is about, narrowed from `string | string[]` (no route repeats `:bookId`).
// Uses `useRoute()`, not the router, so views never import `router.ts` (a cycle). A snapshot, not a
// ref: `App.vue` keys `<RouterView>` on the book id, so switching books remounts the view.
import { useRoute } from "vue-router";

export function useBookId(): string {
  return String(useRoute().params.bookId);
}
