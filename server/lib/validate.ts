// `sValidator` that refuses in the API's error shape instead of the validator's own result object,
// so the client gets a message naming the field.
import { sValidator } from "@hono/standard-validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ValidationTargets } from "hono";

import { fail } from "~/lib/http";

type Issue = StandardSchemaV1.Issue;

/** `ids.0` */
function where(issue: Issue): string {
  return (issue.path ?? [])
    .map((p) => String(typeof p === "object" && p !== null && "key" in p ? p.key : p))
    .join(".");
}

function detailOf(issues: readonly Issue[]): string {
  return issues.map((i) => [where(i), i.message].filter(Boolean).join(": ")).join("; ");
}

/** A drop-in for `sValidator` minus the hook, so no route can forget it. */
export function validate<Schema extends StandardSchemaV1, Target extends keyof ValidationTargets>(
  target: Target,
  schema: Schema,
) {
  // Annotated: inferred `void` (since `fail` throws) makes the handler type `never`, and routes
  // lose the validated input's type.
  return sValidator(target, schema, (result): Response | void => {
    if (result.success) return;
    fail(
      400,
      `The ${result.target} of this request was not valid`,
      detailOf(result.error) || undefined,
    );
  });
}
