// Trying a prompt on one chunk, and the notes a prompt would drop: what the trial sends and how
// its answer reads (`src/lib/promptTrial.ts`), and what the book's panel warns about beside its
// notes (`src/lib/promptNotes.ts`). The components themselves are not mounted here.
import { describe, expect, test } from "bun:test";

import { BUILT_IN_PROMPT, resolvePrompt } from "@/lib/prompt";
import { droppedNotes, withNotesLine } from "@/lib/promptNotes";
import {
  fidelitySummary,
  trialLayers,
  trialRequest,
  trialTime,
  trialTokens,
} from "@/lib/promptTrial";
import type { BookPrompt, ProfilePrompt, PromptTemplate } from "@/types";

const own: PromptTemplate = { system: "Script it.", user: "{{excerpt}}" };
const book: BookPrompt = { ...own, notes: "Em-dashes mark dialogue.", replace: true };
const endpoint: ProfilePrompt = { ...own, mode: "default", notes: "Keep paragraphs apart." };

describe("what a trial sends", () => {
  test("a layer with a draft is the draft; the others are what is saved", () => {
    const saved = { library: own, profilePrompt: endpoint, book: null };
    expect(trialLayers({ book }, saved)).toEqual({ library: own, profile: endpoint, book });
    // null is a draft too: the built-in prompt for the library, none for the others
    expect(trialLayers({ library: null, profilePrompt: null }, saved)).toEqual({
      library: null,
      profile: null,
      book: null,
    });
  });

  test("the request names only the layers there are drafts of, copied as they stand", () => {
    const draft = { ...book };
    const request = trialRequest("deepseek", 3, 2, { book: draft, library: null });
    expect(request).toEqual({ profile: "deepseek", chapterId: 3, part: 2, book, library: null });
    expect("profilePrompt" in request).toBe(false);
    draft.notes = "typed after it was sent";
    expect(request.book?.notes).toBe(book.notes);
  });
});

describe("how an answer reads", () => {
  test("the word check in one sentence", () => {
    const f = { words: 120, missing: 0, added: 0, examples: [], ok: true };
    expect(fidelitySummary(f)).toEqual({ ok: true, text: "Every word came back" });
    expect(
      fidelitySummary({ ...f, ok: false, missing: 3, added: 1, examples: ["said Mara", "x"] }),
    ).toEqual({ ok: false, text: "Left out 3 words, added 1 word — e.g. “said Mara”, “x”" });
  });

  test("tokens, with the thinking when the provider said, and time", () => {
    expect(trialTokens(null)).toBe("");
    expect(trialTokens({ inputTokens: 1204, outputTokens: 388, reasoningTokens: null })).toBe(
      "1,204 in · 388 out",
    );
    expect(trialTokens({ inputTokens: 1204, outputTokens: 388, reasoningTokens: 120 })).toBe(
      "1,204 in · 388 out, 120 of them thinking",
    );
    expect(trialTime(3240)).toBe("3.2 s");
    expect(trialTime(64_000)).toBe("1 min 4 s");
  });
});

describe("notes the prompt in force would drop", () => {
  const notes = { book: "Em-dashes.", endpoint: "Keep paragraphs apart." };

  test("the built-in prompt places both, so nothing is said", () => {
    const resolved = resolvePrompt({ library: null });
    expect(droppedNotes(resolved, notes, "DeepSeek", "book")).toEqual([]);
  });

  test("the book's own prompt without the tags: both said, and fixable here", () => {
    const resolved = resolvePrompt({ library: null, book });
    expect(droppedNotes(resolved, notes, "DeepSeek", "book")).toEqual([
      {
        owner: "book",
        text: "This book's prompt has no {{book.notes}}, so this book's notes are not sent.",
        fixElsewhere: "",
      },
      {
        owner: "endpoint",
        text: "This book's prompt has no {{endpoint.notes}}, so DeepSeek's notes for its model are not sent.",
        fixElsewhere: "",
      },
    ]);
  });

  test("another layer's prompt says where the tag would have to go", () => {
    const resolved = resolvePrompt({ library: own });
    const [d] = droppedNotes(resolved, { endpoint: notes.endpoint }, "DeepSeek", "book");
    expect(d.text).toBe(
      "The library's prompt has no {{endpoint.notes}}, so DeepSeek's notes for its model are not sent.",
    );
    expect(d.fixElsewhere).toBe("the library's prompt on the Endpoints page");
    // notes of nothing but spaces are no notes
    expect(droppedNotes(resolved, { book: "  " }, "DeepSeek", "book")).toEqual([]);
  });

  test("Add the tag puts the built-in prompt's line at the end, beside the other one", () => {
    expect(withNotesLine("", "book")).toBe("Notes on this book: {{book.notes}}");
    const once = withNotesLine("Script it.\n", "book");
    expect(once).toBe("Script it.\n\nNotes on this book: {{book.notes}}");
    expect(withNotesLine(once, "endpoint")).toBe(
      "Script it.\n\nNotes on this book: {{book.notes}}\nNotes for this model: {{endpoint.notes}}",
    );
    // and with both added, nothing is dropped any more
    const fixed = { ...book, system: withNotesLine(once, "endpoint") };
    expect(droppedNotes(resolvePrompt({ library: null, book: fixed }), notes, "D", "book")).toEqual(
      [],
    );
    expect(BUILT_IN_PROMPT.system.endsWith(withNotesLine("", "endpoint"))).toBe(true);
  });
});
