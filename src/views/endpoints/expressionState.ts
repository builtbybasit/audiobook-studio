import { reactive } from "vue";
import { onDemoReset } from "@/lib/pageState";
import type { Endpoint, ExpressionConfig } from "@/types";

// Keep unfinished capability edits when switching endpoint tabs or opening the inline editor.
const drafts = reactive<Record<string, ExpressionConfig>>({});
export function expressionDraft(ep: Endpoint): ExpressionConfig {
  return (drafts[ep.id] ??= structuredClone(
    ep.expressions
      ? JSON.parse(JSON.stringify(ep.expressions))
      : {
          status: "unknown",
          model: ep.model,
          baseUrl: ep.baseUrl,
          tags: [],
        },
  ));
}
export function resetExpressionDraft(ep: Endpoint): void {
  delete drafts[ep.id];
}

// the endpoint a draft belongs to is restored by a demo reset, so an unfinished edit of it goes too
onDemoReset(() => {
  for (const id of Object.keys(drafts)) delete drafts[id];
});
