// The text sent before a request as context: the end of the chunk before it.
import { describe, expect, test } from "bun:test";

import { beforeOf } from "~/script/chunks";

describe("the text before a request", () => {
  test("is nothing for a chapter's first, and the last paragraphs that fit for the rest", () => {
    const chunks = ["One.\n\nTwo  words.\n\nThree.", "Four."];
    expect(beforeOf(chunks, 0)).toBe("");
    expect(beforeOf(chunks, 1)).toBe("One.\nTwo words.\nThree.");
  });

  test("keeps only the tail of a last paragraph too long to send whole, from a word", () => {
    const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const before = beforeOf([`Earlier.\n\n${long}`, "Next."], 1);
    expect(before.startsWith("…w")).toBe(true);
    expect(before.endsWith("w299")).toBe(true);
    expect(before.length).toBeLessThanOrEqual(801);
  });
});
