import { describe, expect, test } from "bun:test";

import {
  BUILT_IN_PROMPT,
  OUTPUT_FORMAT,
  SCRIPT_MARKERS,
  fill,
  fingerprint,
  lineEffectsOf,
  outputFormat,
  promptProblems,
  promptWarnings,
  renderPrompt,
  resolvePrompt,
  sampleVars,
  unplacedNotes,
  type PromptVars,
} from "@/lib/prompt";

const vars = (over: Partial<PromptVars> = {}): PromptVars => ({
  ...sampleVars("“Is someone there?” Mara whispered.", { name: "Luna", model: "gpt-6-luna" }),
  ...over,
});

describe("fill", () => {
  test("fills every tag once, and never reads what it put in for tags", () => {
    const out = fill("{{book.title}} · {{ chapter.number }} · {{excerpt}}", {
      ...vars(),
      excerpt: "a {{cast}} in the prose",
    });
    expect(out).toBe("The Lamplighter · 1 · a {{cast}} in the prose");
  });

  test("drops a line whose tags all came out empty, and keeps one with text of its own", () => {
    expect(fill("A\nNotes on this book: {{book.notes}}\nB", vars())).toBe("A\nB");
    const noted = vars({ book: { title: "T", author: "", notes: "Em-dashes mark dialogue." } });
    expect(fill("Notes: {{book.notes}}", noted)).toBe("Notes: Em-dashes mark dialogue.");
  });

  test("the cast leaves out the Narrator and Unknown, and details each speaker", () => {
    const cast = [
      { name: "Narrator" },
      { name: "Unknown" },
      {
        name: "Mara",
        gender: "f" as const,
        age: "adult" as const,
        aliases: ["Mar"],
        description: "A lamplighter.",
      },
      { name: "Tobiah" },
    ];
    // gender, age and other names go to everyone; the description only with the details
    expect(fill("{{cast}}", vars({ cast }))).toBe("Mara (female, adult; also called Mar), Tobiah");
    expect(fill("{{cast.details}}", vars({ cast }))).toBe(
      "- Mara (female, adult; also called Mar): A lamplighter.\n- Tobiah",
    );
    expect(fill("{{cast}}", vars({ cast: [] }))).toBe("(none yet)");
  });

  test("a persona says whose it is, between its gender and its other names", () => {
    const cast = [
      { name: "Sunny", gender: "m" as const },
      { name: "Lord of Shadows", gender: "m" as const, personaOf: "Sunny", aliases: ["Mongrel"] },
    ];
    expect(fill("{{cast}}", vars({ cast }))).toBe(
      "Sunny (male), Lord of Shadows (male; persona of Sunny; also called Mongrel)",
    );
    expect(fill("{{cast.details}}", vars({ cast }))).toContain(
      "- Lord of Shadows (male; persona of Sunny; also called Mongrel)",
    );
  });

  test("leaves an unknown tag as it was written", () => {
    expect(fill("{{nope}}", vars())).toBe("{{nope}}");
  });
});

describe("renderPrompt", () => {
  test("the built-in prompt sends today's user message and ends the system prompt with the format", () => {
    const r = renderPrompt(BUILT_IN_PROMPT, vars());
    // a chapter's first request with no recap before it: both context lines drop out
    expect(r.user).toBe(
      "Chapter: The Bridge\nKnown cast: Mara (female)\n\nExcerpt:\n“Is someone there?” Mara whispered.",
    );
    expect(r.system.endsWith(OUTPUT_FORMAT)).toBe(true);
    expect(r.system).not.toContain("Notes on this book");
  });

  test("the built-in prompt sends the previous chapter's recap and the text before the excerpt", () => {
    const { user } = renderPrompt(
      BUILT_IN_PROMPT,
      vars({ recap: "Mara and Tobiah  at the door;\nTobiah spoke last.", before: "“Who is it?”" }),
    );
    expect(user).toContain(
      "Where the previous chapter left off: Mara and Tobiah at the door; Tobiah spoke last.\n",
    );
    expect(user).toContain("(context only, not part of the excerpt): “Who is it?”\n\nExcerpt:");
  });

  test("an empty system prompt still sends the output format", () => {
    expect(renderPrompt({ system: "", user: "{{excerpt}}" }, vars()).system).toBe(OUTPUT_FORMAT);
  });

  test("the built-in rule 5 gives a persona's lines to the persona", () => {
    const [rule5] = BUILT_IN_PROMPT.system.match(/^5\. [\s\S]*?(?=\n6\. )/m)!;
    expect(rule5).toContain("A cast entry marked “persona of” is one");
    expect(rule5).toContain("go to the persona's cast name");
    expect(rule5).toContain("An entry marked “masked, identity unknown”");
  });
});

describe("line effects in the output format", () => {
  const OFFERED = [
    { name: "Telephone", useWhen: "heard through a phone." },
    { name: "Inner  echo", useWhen: "words sent\nmind to mind" },
  ];

  test("none offered leaves the format as it always was", () => {
    expect(outputFormat(SCRIPT_MARKERS[0], [])).toBe(OUTPUT_FORMAT);
    expect(OUTPUT_FORMAT).not.toContain('"effects"');
    expect(renderPrompt(BUILT_IN_PROMPT, vars({ lineEffects: [] })).system).toEndWith(
      OUTPUT_FORMAT,
    );
  });

  test("offered ones are listed by name, with when, just before the direction", () => {
    const { system } = renderPrompt(BUILT_IN_PROMPT, vars({ lineEffects: OFFERED }));
    expect(system).toContain(
      '- "text": the words of the line, copied verbatim from the excerpt.\n- "effects" (optional): sound effects for how this line is heard, by name, only from this list — "Telephone": heard through a phone; "Inner echo": words sent mind to mind. Several may apply to one line.',
    );
    expect(system).toContain(
      'never add a mask effect to a persona\'s lines.\n- "direction" (optional):',
    );
    // what the library typed is not read as a replacement pattern
    expect(outputFormat(null, [{ name: "$&", useWhen: "$'" }])).toContain(`"$&": $'.`);
  });

  test("only the library's effects with a use-when are offered", () => {
    const fx = (id: string, useWhen?: string) => ({ id, name: id, chain: [], useWhen });
    expect(lineEffectsOf([fx("a", "on a phone"), fx("b"), fx("c", " ")]).map((e) => e.id)).toEqual([
      "a",
    ]);
  });
});

describe("resolvePrompt", () => {
  const library = { system: "LIB", user: "LIB {{excerpt}}" };
  const book = { notes: "", replace: true, system: "BOOK", user: "BOOK {{excerpt}}" };

  test("built-in, then the library's, then the endpoint's, then the book's replacement", () => {
    expect(resolvePrompt({ library: null }).origin.from).toBe("built-in");
    expect(resolvePrompt({ library }).system).toBe("LIB");
    const replace = { mode: "replace" as const, system: "EP", user: "EP {{excerpt}}", notes: "" };
    expect(resolvePrompt({ library, profile: replace }).system).toBe("EP");
    expect(resolvePrompt({ library, profile: replace, book }).system).toBe("BOOK");
    expect(resolvePrompt({ library, book: { ...book, replace: false } }).system).toBe("LIB");
  });

  test("an endpoint's kept replacement changes nothing while it is on Default", () => {
    const kept = resolvePrompt({
      library,
      profile: { mode: "default", system: "X", user: "Y", notes: "" },
    });
    expect(kept.system).toBe("LIB");
    expect(kept.origin).toEqual({ from: "library", fingerprint: fingerprint(library) });
  });

  test("notes are placed by their tags, and a template without one drops them", () => {
    const withEndpoint = vars({
      endpoint: { name: "DeepSeek", model: "deepseek-chat", notes: "Keep paragraphs apart." },
    });
    expect(renderPrompt(BUILT_IN_PROMPT, withEndpoint).system).toContain(
      "Notes for this model: Keep paragraphs apart.",
    );
    expect(renderPrompt(BUILT_IN_PROMPT, vars()).system).not.toContain("Notes for this model");
    const bare = { system: "S", user: "{{excerpt}}" };
    expect(unplacedNotes(bare, { book: "B", endpoint: "E" })).toEqual(["book", "endpoint"]);
    expect(unplacedNotes(BUILT_IN_PROMPT, { book: "B", endpoint: " " })).toEqual([]);
  });

  test("the fingerprint follows the text and nothing else", () => {
    expect(fingerprint(library)).toBe(fingerprint({ ...library }));
    expect(fingerprint(library)).not.toBe(fingerprint({ ...library, system: "LIB." }));
    expect(fingerprint(library)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("checks", () => {
  test("the built-in prompt passes", () => {
    expect(promptProblems(BUILT_IN_PROMPT)).toEqual([]);
    expect(promptWarnings(BUILT_IN_PROMPT)).toEqual([]);
  });

  test("a whole prompt needs one excerpt, in the user message, and known tags", () => {
    expect(promptProblems({ system: "", user: "no text" })).toEqual([
      "The user message must include {{excerpt}}, the text to script.",
    ]);
    expect(promptProblems({ system: "{{excerpt}}", user: "{{excerpt}}" })[0]).toContain(
      "not the system prompt",
    );
    expect(promptProblems({ system: "", user: "{{excerpt}}{{excerpt}}" })[0]).toContain(
      "only once",
    );
    expect(promptProblems({ system: "{{book.name}}", user: "{{excerpt}}" })).toEqual([
      "The system prompt names {{book.name}}, which is not a tag.",
    ]);
  });

  test("a tag that moves every chapter in the system prompt is a warning", () => {
    const [warning] = promptWarnings({ system: "{{chapter.title}} {{book.title}}", user: "" });
    expect(warning).toContain("{{chapter.title}}");
    expect(promptWarnings({ system: "{{chapter.title}} {{book.title}}", user: "" })).toHaveLength(
      1,
    );
  });
});
