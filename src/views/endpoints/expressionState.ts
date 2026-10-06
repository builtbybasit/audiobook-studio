import { reactive } from "vue";
import { expressionDefaults } from "@/lib/expressions";
import type { Endpoint, ExpressionConfig } from "@/types";

// Keep unfinished capability edits when switching endpoint tabs or opening the inline editor.
const drafts = reactive<Record<string, ExpressionConfig>>({});
export function expressionDraft(ep: Endpoint): ExpressionConfig {
  return (drafts[ep.id] ??= structuredClone(
    ep.expressions ? JSON.parse(JSON.stringify(ep.expressions)) : expressionDefaults(ep),
  ));
}
/** Whether the endpoint has edits on its Expressions tab not yet saved. */
export const expressionDirty = (ep: Endpoint): boolean =>
  !!drafts[ep.id] &&
  JSON.stringify(drafts[ep.id]) !== JSON.stringify(ep.expressions ?? expressionDefaults(ep));
export function resetExpressionDraft(ep: Endpoint): void {
  delete drafts[ep.id];
}
