import { expect, test } from "bun:test";
import { queryIds, queryIdSet, queryText } from "@/lib/query";
import { clockDuration, minuteDuration } from "@/lib/time";

test("empty route state contains no invented zero id", () => {
  expect(queryIds(undefined)).toEqual([]);
  expect(queryIds("")).toEqual([]);
  expect(queryIdSet(null)).toEqual(new Set());
});

test("route helpers accept Vue Router arrays and keep only positive ids", () => {
  expect(queryText(["find me", "ignore me"])).toBe("find me");
  expect(queryIds("3, 7, nope, 0, -2")).toEqual([3, 7]);
});

test("rounded durations carry into the next minute", () => {
  expect(clockDuration(179.8)).toBe("3:00");
  expect(minuteDuration(179.8)).toBe("3m 00s");
  expect(clockDuration(-1)).toBe("0:00");
});
