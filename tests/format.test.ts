import { expect, test } from "bun:test";
import { hhmm, isMacPlatform } from "@/lib/format";

test("a clock time is to the minute", () => {
  const at = new Date(2026, 0, 5, 14, 7, 42).getTime();
  expect(hhmm(at)).toBe(
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
  expect(hhmm(at)).not.toContain("42");
});

test("⌘ is for Apple's platforms", () => {
  expect(["MacIntel", "iPhone", "Win32", "Linux x86_64", ""].map(isMacPlatform)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
});
