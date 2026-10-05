// What a job is called on the Queue and the page its work is looked at on, one entry per kind.
//
// A check by ear has no page of its own: what it heard lands on the Narration page, as flags on
// the lines it heard wrong, so that is where it opens — on the flagged lines when it flagged any.
import type { RouteLocationRaw } from "vue-router";

import type { Job, JobKind } from "@/types";

/** a job's kind as the Queue's running rows name it */
export const KIND_LABEL: Record<JobKind, string> = {
  scripting: "Scripting",
  narration: "Narration",
  export: "Export",
  check: "Check by ear",
};

/** the filter the Narration page opens on for this job, if any */
function narrationFilter(j: Job): string | undefined {
  switch (j.kind) {
    case "narration":
      return j.status === "failed" ? "failed" : undefined;
    case "check":
      return j.checkRun?.mismatched ? "flagged" : undefined;
    default:
      return undefined;
  }
}

/** the stage page a job's work is on */
export const PAGE: Record<JobKind, string> = {
  scripting: "scripting",
  narration: "narration",
  export: "export",
  check: "narration",
};

/** The page a job's work is looked at on, at its chapter when it has one. */
export function stageLink(j: Job): RouteLocationRaw {
  const filter = narrationFilter(j);
  return {
    path: `/book/${j.bookId}/${PAGE[j.kind]}`,
    query:
      j.chapterId == null ? undefined : { ch: String(j.chapterId), ...(filter ? { filter } : {}) },
  };
}
