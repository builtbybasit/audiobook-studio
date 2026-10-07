// The one line under a request's cost on the Activity list: a cost nobody knows says why, and a
// missing rate is only one of the reasons.
import { describe, expect, test } from "bun:test";

import type { RequestRecord } from "@/types";
import { COST_BASIS_DETAIL, costDetail } from "@/lib/pricing";

const row = (over: Partial<RequestRecord>) =>
  ({ costBasis: "unknown", status: "done", ...over }) as Pick<
    RequestRecord,
    "costBasis" | "status" | "priced" | "speech"
  >;
const receipt = {} as NonNullable<RequestRecord["speech"]>;

describe("a cost's one line", () => {
  test("is what its basis means when the cost is known", () => {
    expect(costDetail(row({ costBasis: "calculated" }))).toBe(COST_BASIS_DETAIL.calculated);
    expect(costDetail(row({ costBasis: "provider-reported" }))).toBe(
      COST_BASIS_DETAIL["provider-reported"],
    );
  });

  test("says a request cancelled once it was out may have been charged, not that no rate is set", () => {
    for (const r of [row({ status: "cancelled" }), row({ status: "cancelled", speech: receipt })])
      expect(costDetail(r)).toMatch(/^cancelled after it was sent/);
  });

  test("says a request that reported no usage did not report it, not that no rate is set", () => {
    // a scripting request answered without usage has no receipt
    expect(costDetail(row({ status: "done" }))).toMatch(/did not report what it used/);
    expect(costDetail(row({ status: "failed" }))).toMatch(/did not report what it used/);
  });

  test("says no rate is set only for a receipt priced with a rate nobody set", () => {
    expect(costDetail(row({ speech: receipt }))).toBe(COST_BASIS_DETAIL.unknown);
  });
});
