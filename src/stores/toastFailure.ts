// Saying a request failed, the one way every store says it. A refused change is never applied
// locally; the store toasts (in the server's words when given) and reads back what it moved.
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
