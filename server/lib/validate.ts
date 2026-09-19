// Request validation, failing in the one shape the API uses.
//
// `sValidator` answers a bad request with the validator's own result object — `{success, error, data}`
// — which is a second error contract nobody agreed to. A client written against `server/lib/http.ts`
// finds no `error.message` in it and can only say "Request failed (400)", which is a worse message
// than the validator already had and throws away the part that says *which field*.
//
// This is the same middleware with that one hole closed: every refusal, from a missing file to an
// unhandled crash, leaves the server as `{ error: { message, detail? } }`.
import { sValidator } from "@hono/standard-validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ValidationTargets } from "hono";

import { fail } from "~/lib/http";

/** One complaint, in the shape every Standard Schema library reports it. */
type Issue = StandardSchemaV1.Issue;

/** `ids.0` — where in the request the complaint is about, in the words the request used. */
function where(issue: Issue): string {
  return (issue.path ?? [])
    .map((p) => String(typeof p === "object" && p !== null && "key" in p ? p.key : p))
    .join(".");
}

/** What was wrong, one complaint per line, with the field it is about in front of it. */
function detailOf(issues: readonly Issue[]): string {
  return issues.map((i) => [where(i), i.message].filter(Boolean).join(": ")).join("; ");
}

/**
 * Validate one part of the request, and say so in the API's own error shape when it does not hold.
 *
 * A drop-in for `sValidator` minus the hook, so a route reads the same as before and cannot opt out
 * of the contract by forgetting one.
 */
export function validate<Schema extends StandardSchemaV1, Target extends keyof ValidationTargets>(
  target: Target,
  schema: Schema,
) {
  // Annotated `Response | void` rather than left to inference: `fail` throws, so the hook's own
  // return type is `void`, and the middleware's handler type is then `never` — a route using it
  // stops type-checking its own validated input.
  return sValidator(target, schema, (result): Response | void => {
    if (result.success) return;
    fail(
      400,
      `The ${result.target} of this request was not valid`,
      detailOf(result.error) || undefined,
    );
  });
}
