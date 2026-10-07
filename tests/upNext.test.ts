// The Queue page's "Up next" list (`upNextGroups`): run order, a bulk run folded into one row, and a
// run split by "Run next" kept as separate rows so the positions stay true.
import { expect, test } from "bun:test";

import { jobLabel, upNextGroups } from "@/lib/queue";
import type { Job } from "@/types";

const job = (id: number, bulkId?: number, priority?: number) =>
  ({
    id,
    priority,
    bulk: bulkId ? { id: bulkId, op: "Narrate", index: 1, total: 1 } : undefined,
  }) as Job;

test("groups a run's consecutive jobs in run order, a moved job splitting the run", () => {
  // run 7 is jobs 1–4; "Run next" on its job 3 and the lone job 5 puts them ahead of the rest
  const groups = upNextGroups([job(1, 7), job(2, 7), job(3, 7, 1), job(4, 7), job(5, 0, 1)]);
  expect(groups.map((g) => [g.position, g.jobs.map((j) => j.id)])).toEqual([
    [1, [3]],
    [2, [5]],
    [3, [1, 2, 4]],
  ]);
});

test("puts the chapter after the job's verb, and leaves a label without one as it is", () => {
  expect(jobLabel("Narrate", "ch 2")).toBe("Narrate · ch 2");
  expect(jobLabel("Script · OpenAI", "ch 14")).toBe("Script · ch 14 · OpenAI");
  expect(jobLabel("Export", undefined)).toBe("Export");
});
