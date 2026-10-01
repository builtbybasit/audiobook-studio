// The Cast page's appearance strip: one band per run of chapters a speaker is in, not one element
// per chapter, and chapters outside the book left off.
import { expect, test } from "bun:test";
import { appearanceStrip } from "@/views/cast/strip";

const V = "var(--color-violet-500)";

test("a run of chapters is one band, gaps cut between chapters on a short book", () => {
  const s = appearanceStrip(new Set([5, 2, 3, 0, 11]), 10);
  const at = (k: number) => `calc((100% + 1px) * ${k / 10})`;
  expect(s.backgroundImage).toBe(
    `linear-gradient(to right, transparent ${at(1)}, ${V} ${at(1)} ${at(3)}, transparent ${at(3)}, ` +
      `transparent ${at(4)}, ${V} ${at(4)} ${at(5)}, transparent ${at(5)})`,
  );
  expect(s.maskImage).toContain("calc((100% + 1px) / 10)");
});

test("a long book has no gaps, and a one-chapter speaker still shows", () => {
  const s = appearanceStrip(new Set([440]), 878);
  expect(s.backgroundImage).toContain(`${V} 50% max(${(440 / 878) * 100}%, calc(50% + 1px))`);
  expect(s.maskImage).toBeUndefined();
  expect(appearanceStrip(new Set(), 878)).toEqual({});
});
