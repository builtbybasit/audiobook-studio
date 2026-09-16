// Which book the page is about.
//
// Route params arrive typed as `string | string[]`, because a path *could* declare a repeatable
// segment. None of ours does: every `/book/:bookId/…` route in `src/router.ts` declares it as a
// single segment, so this narrows it once here instead of at each of the eight call sites.
//
// It reads `useRoute()` rather than the router instance, which is why it belongs here and not
// beside the route table: a view that needs the open book's id has no business importing the module
// that mounts the views. It used to, and that was a cycle — `router.ts` imported the view, the view
// imported `router.ts` back — held together only by the fact that this is a hoisted function nobody
// calls until setup runs.
//
// The value is a snapshot, not a reactive ref. `App.vue` keys `<RouterView>` on the book id, so
// going from one book's stage straight to another's remounts the view rather than mutating it
// underneath; a view reads this once and keeps it for its lifetime.
import { useRoute } from "vue-router";

export function useBookId(): string {
  return String(useRoute().params.bookId);
}
