// Reads, as queries.
//
// The stores own state and every change to it; these composables are how a page asks for what
// the stores hold and, with a server answering, how that state is read from the server and kept
// fresh. Each one takes the mode choice once — the service when there is one, the seeded store
// when there is not — so no page grows a demo-versus-real branch of its own. A store that changes
// something a query reads invalidates it here, by key.
export { keys } from "@/queries/keys";
export { invalidate } from "@/queries/invalidate";
export { useChapterText, chapterTextNow, chapterPartsNow } from "@/queries/chapterText";
export { useChapterScript } from "@/queries/chapterScript";
export { useChapterHistory } from "@/queries/history";
export { useCast } from "@/queries/cast";
export { useBookExports } from "@/queries/exports";
export { useBookJobs, POLL_MS } from "@/queries/jobs";
