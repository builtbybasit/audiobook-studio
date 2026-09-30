// Reads, as queries.
//
// The stores own state and every change to it; these composables are how a page asks for what
// the stores hold, and how that state is read from the server and kept fresh. A store that
// changes something a query reads invalidates it here, by key.
export { keys } from "@/queries/keys";
export { invalidate } from "@/queries/invalidate";
export { fetchBook, fetchShelf, useBook, useBooks, useShelf } from "@/queries/library";
export { useChapterText, chapterTextNow, chapterPartsNow } from "@/queries/chapterText";
export { useChapterTexts, loadChapterTexts, chapterTextRead } from "@/queries/chapterTexts";
export {
  fetchScript,
  useBookScripts,
  useChapterScript,
  useChapterScripts,
} from "@/queries/chapterScript";
export { fetchHistory, useChapterHistory } from "@/queries/history";
export { fetchCast, useCast } from "@/queries/cast";
export { useBookExports } from "@/queries/exports";
export { useBookJobs, POLL_MS } from "@/queries/jobs";
export { useBookSpend, useLibrarySpend, spendMoved } from "@/queries/spend";
export { useEndpointHistory } from "@/queries/endpointHistory";
export { useEndpointLive } from "@/queries/endpointLive";
