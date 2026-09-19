// The fake scripting model: deterministic, honest about what it is, and abortable.
import { describe, expect, test } from "bun:test";

import { attributeParagraph, fakeScriptingProvider, UNKNOWN_SPEAKER } from "~/providers/fake";

describe("attributing a paragraph", () => {
  test("narration stays with the narrator and a quote becomes dialogue", () => {
    // the tag stays in the narration: a narrator reads "said Mara" out loud
    expect(attributeParagraph("The door opened. “Come in,” said Mara. He did.")).toEqual([
      { type: "narration", speaker: "Narrator", text: "The door opened." },
      { type: "dialogue", speaker: "Mara", text: "Come in," },
      { type: "narration", speaker: "Narrator", text: "said Mara. He did." },
    ]);
  });

  test("a speaker named before the verb is found too, and two names are kept together", () => {
    const [line] = attributeParagraph('"We leave at dawn." Old Tobiah muttered it twice.');
    expect(line).toEqual({ type: "dialogue", speaker: "Old Tobiah", text: "We leave at dawn." });
  });

  test("a quote with nobody named beside it is not guessed at", () => {
    expect(attributeParagraph("“Who goes there?”")).toEqual([
      { type: "dialogue", speaker: UNKNOWN_SPEAKER, text: "Who goes there?" },
    ]);
  });

  test("a paragraph with no quotes is one narration line", () => {
    expect(attributeParagraph("Rain fell all night.")).toHaveLength(1);
  });
});

describe("the provider", () => {
  test("reports progress a paragraph at a time and answers the same way twice", async () => {
    const provider = fakeScriptingProvider();
    const text = "One.\n\nTwo.\n\n“Three,” said Ann.";
    const seen: [number, number][] = [];
    const first = await provider.script({
      title: "t",
      text,
      signal: new AbortController().signal,
      progress: (d, t) => seen.push([d, t]),
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    const second = await provider.script({
      title: "t",
      text,
      signal: new AbortController().signal,
    });
    expect(second).toEqual(first);
  });

  test("stops when the signal is aborted mid-run", async () => {
    const provider = fakeScriptingProvider({ delayMs: 5 });
    const controller = new AbortController();
    const run = provider.script({
      title: "t",
      text: "One.\n\nTwo.\n\nThree.",
      signal: controller.signal,
      progress: () => controller.abort(new DOMException("stop", "AbortError")),
    });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  test("can be told to fail, for the failure path", async () => {
    const provider = fakeScriptingProvider({ failWith: "no" });
    await expect(
      provider.script({ title: "t", text: "x", signal: new AbortController().signal }),
    ).rejects.toThrow("no");
  });
});
