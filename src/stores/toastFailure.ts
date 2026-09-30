// Saying a request failed, the one way every store says it.
//
// A change the server refused changes nothing here: the store that asked says so in a toast, in
// the server's own words when it gave any and otherwise as what was being tried, and reads back
// whatever it had already moved. Applying the change locally anyway would show a library the
// server does not have.
import { ApiError } from "@/services/http";
import { useUiStore } from "@/stores/ui";

/** Say that `what` ("save this speaker") could not be done, and why when the server said. */
export function toastFailure(what: string, cause: unknown): void {
  const api = cause instanceof ApiError ? cause : null;
  useUiStore().toast(api ? api.message : `Could not ${what}`, {
    kind: "error",
    description: api?.detail ?? (cause instanceof Error ? cause.message : undefined),
    timeout: 8000,
  });
}
