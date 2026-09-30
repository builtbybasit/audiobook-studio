// Site text: what a chapter carries that is not the story, and what of it is read aloud.
//
// The detector only ever suggests, so a miss costs a person a click; a false alarm costs more, a
// story line with a badge on it that says it is a website's. So the story sentences below matter as
// much as the boilerplate: each is the kind of line a novel says freely — a letter read at a table,
// a council's vote, a note under a door — and none of them may trip a signal.
//
// The simulated scripter is held to the same rules, because it is what a demo re-script shows: it
// marks what the detector sees and still hands back every word it was sent.
import { describe, expect, test } from "bun:test";

import { isSpoken, siteTextSignals } from "@/lib/siteText";
import { fakeScriptingProvider } from "~/providers/fake";
import { fidelity } from "~/providers/chatScripting";
import { siteChecks } from "~/script/siteCheck";
import { BOILERPLATE, SITE_TEXT_CHAPTER } from "~/demo/seed/fixtures/siteText";
import { makeWorld } from "~/demo/seed/world";
import { chapterParts, partsText } from "~/demo/seed/world/text";
import type { SegmentType } from "@/types";

const ADDRESS = "names a web address";
const WHERE = "tells the reader where to read";
const TAKEN = "says the text was taken from a site";
const NOTE = "opens as a translator's or author's note";
const SUPPORT = "asks the reader for support";

describe("siteTextSignals", () => {
  test.each([
    ["novelbin.com", [ADDRESS]],
    ["Visit lightnovelpub.net for more.", [ADDRESS]],
    ["novelbin . com", [ADDRESS]],
    ["novelbin[dot]com", [ADDRESS]],
    ["novelbin [dot] com", [ADDRESS]],
    ["novelbin dot com", [ADDRESS]],
    ["freewebnovel (dot) com", [ADDRESS]],
    ["Read the latest chapters at novelbin.com", [ADDRESS, WHERE]],
    ["Read the latest chapters at Webnovel", [WHERE]],
    ["Find the original translation on our website!", [WHERE]],
    ["Enjoying the new chapters? Read more chapters on the site", [WHERE]],
    ["This chapter was stolen from wuxiaworld.site", [ADDRESS, TAKEN]],
    ["This content was taken without permission.", [TAKEN]],
    ["If you're reading this on a site other than the original, it was stolen.", [TAKEN]],
    ["(TL note: Lan'er is a pet name.)", [NOTE]],
    ["[T/N: a li is about half a kilometre]", [NOTE]],
    ["A/N: sorry for the late chapter!", [NOTE]],
    ["AN: two chapters this week", [NOTE]],
    ["T/N - the pun does not survive translation", [NOTE]],
    ["Translator's note: cultivation ranks are listed in the glossary.", [NOTE]],
    ["Author’s note — thank you all for reading.", [NOTE]],
    ["Support me on Patreon for advance chapters.", [SUPPORT]],
    ["Buy me a coffee on ko-fi", [SUPPORT]],
    ["Please vote for this novel with your power stones!", [SUPPORT]],
  ] as [string, string[]][])("%p gives itself away", (text, saw) => {
    expect(siteTextSignals(text)).toEqual(saw);
  });

  test.each([
    "She read the letter at the table.",
    "The council will vote at dawn.",
    "He found the note under the door.",
    "Visit the site of the old temple.",
    "The author of the letter was unknown.",
    "He took the latest train.",
    "He waited... and waited... and at last the gate opened.",
    "Swords, spears, shields, etc. were piled by the door.",
    "They brought rope, lanterns, etc. Me, I brought nothing.",
    "“Put a dot here, and another there,” said the Elder.",
    "“Dot, come here,” said Mara.",
    // two sentences whose words would spell an address if the space after a full stop counted
    "Don't look at me. Me? I was never here.",
    "He climbed to the top. Top of the world, he thought.",
    // a manual in a cultivation novel has chapters too
    "He would read the next chapter of the manual at dawn.",
    "She read the new chapters of the sect rules on the boat.",
    // a name or a stammer that only looks like an abbreviation
    "An—an arrow struck the post.",
    "Ed—wait for me!",
    "Tn the old tongue it meant nothing.",
    "Translation was never his strength.",
    "The elder donated nothing and supported no one.",
    "She would donate the pills to the orphanage.",
    "“Support me from the left flank!”",
    "The cave glittered with power stones.",
    "The pill was stolen from the Elder’s furnace.",
    "Mud scraped from his boots fell on the jade steps.",
    "If you are reading this at dawn, I am already gone.",
  ])("%p is story", (text) => {
    expect(siteTextSignals(text)).toEqual([]);
  });
});

describe("isSpoken", () => {
  const story: SegmentType[] = ["narration", "dialogue", "thought"];

  test("every story line is read, whatever the book says about notes", () => {
    for (const type of story)
      for (const book of [undefined, {}, { readNotes: false }, { readNotes: true }])
        expect(isSpoken({ type }, book)).toBe(true);
  });

  test("site text is never read, even in a book that reads its notes", () => {
    for (const book of [undefined, {}, { readNotes: false }, { readNotes: true }])
      expect(isSpoken({ type: "watermark" }, book)).toBe(false);
  });

  test("a note is read only when the book says so; unsaid, it is skipped", () => {
    expect(isSpoken({ type: "note" }, undefined)).toBe(false);
    expect(isSpoken({ type: "note" }, {})).toBe(false);
    expect(isSpoken({ type: "note" }, { readNotes: false })).toBe(false);
    expect(isSpoken({ type: "note" }, { readNotes: true })).toBe(true);
  });
});

describe("the simulated scripter marks site text", () => {
  const script = (text: string) =>
    fakeScriptingProvider().script({
      title: "t",
      target: null,
      cast: [],
      text,
      signal: new AbortController().signal,
    });

  test("a paragraph of boilerplate between two of story is a watermark line of its own", async () => {
    const text = [
      "The mist thinned over the peak.",
      "Read the latest chapters at novelbin.com",
      "“Again,” said Elder Mo.",
    ].join("\n\n");
    const lines = await script(text);
    expect(lines).toEqual([
      { type: "narration", speaker: "Narrator", text: "The mist thinned over the peak." },
      { type: "watermark", speaker: "Narrator", text: "Read the latest chapters at novelbin.com" },
      { type: "dialogue", speaker: "Elder Mo", text: "Again," },
      { type: "narration", speaker: "Narrator", text: "said Elder Mo." },
    ]);
    expect(fidelity(text, lines).ok).toBe(true);
  });

  test("a translator's note is a note line, label, brackets and every sentence in it", async () => {
    const text =
      "Lan’er laughed.\n\n(TL note: Lan’er is a pet name. The er on the end makes it fond.)";
    const lines = await script(text);
    expect(lines.map((l) => [l.type, l.text])).toEqual([
      ["narration", "Lan’er laughed."],
      ["note", "(TL note: Lan’er is a pet name. The er on the end makes it fond.)"],
    ]);
  });

  test("a sentence of boilerplate inside a paragraph is cut out of it, and the story either side kept", async () => {
    const text =
      "Ji Ning bowed. This chapter was stolen from lightnovelpub[dot]net. “Rise,” said Elder Mo. He rose.";
    const lines = await script(text);
    expect(lines).toEqual([
      { type: "narration", speaker: "Narrator", text: "Ji Ning bowed." },
      {
        type: "watermark",
        speaker: "Narrator",
        text: "This chapter was stolen from lightnovelpub[dot]net.",
      },
      { type: "dialogue", speaker: "Elder Mo", text: "Rise," },
      { type: "narration", speaker: "Narrator", text: "said Elder Mo. He rose." },
    ]);
    expect(fidelity(text, lines).ok).toBe(true);
  });

  test("a spaced-out address is not a sentence break, and a quote is not cut inside", async () => {
    const lines = await script(
      "“Stop. Look.” She pointed. Find the full novel at novelbin . com for free.",
    );
    expect(lines.map((l) => [l.type, l.text])).toEqual([
      ["dialogue", "Stop. Look."],
      ["narration", "She pointed."],
      ["watermark", "Find the full novel at novelbin . com for free."],
    ]);
  });

  test("story that only sounds like it is left as story", async () => {
    const text =
      "She read the letter at the table. The council will vote at dawn.\n\nHe found the note under the door.";
    const lines = await script(text);
    expect(lines.every((l) => l.type === "narration")).toBe(true);
    expect(lines).toHaveLength(2);
  });
});

describe("the demo's web-novel chapter", () => {
  const world = makeWorld();
  const chapter = world.chapters.cliche.find((c) => c.id === SITE_TEXT_CHAPTER)!;
  const script = world.segments[`cliche:${SITE_TEXT_CHAPTER}`];
  const prose = partsText(chapterParts("cliche", chapter.id, chapter));

  test("carries boilerplate, a sentence cut in three, a note and the detector's two suggestions", () => {
    const at = script.findIndex((s) => s.text === "Ji Ning drew a slow breath and");
    expect(script.slice(at, at + 3).map((s) => s.type)).toEqual([
      "narration",
      "watermark",
      "narration",
    ]);
    expect(script.filter((s) => s.type === "watermark")).toHaveLength(3);
    expect(script.filter((s) => s.type === "note")).toHaveLength(1);
    expect(script.filter((s) => s.siteCheck).map((s) => [s.type, s.siteCheck?.suggest])).toEqual([
      ["watermark", "narration"],
      ["narration", "watermark"],
    ]);
    // and they are exactly what the detector makes of the chapter, reason and all — the demo shows
    // no suggestion the real one would not give (repeats aside, which need the other chapters)
    const bare = script.map(({ siteCheck: _seeded, ...s }) => s);
    expect(siteChecks(bare, () => 0).map((s) => s.siteCheck)).toEqual(
      script.map((s) => s.siteCheck),
    );
    // the suggestions are the detector's own: the story line gives itself away, the other does not
    for (const s of script.filter((x) => x.siteCheck))
      expect(siteTextSignals(s.text).length > 0).toBe(s.siteCheck!.suggest === "watermark");
    // nothing marked is narrated in the seed, and every line has its place
    expect(chapter.narration).toBe("none");
    expect(script.map((s) => s.id)).toEqual(script.map((_, i) => i + 1));
  });

  test("its script and its prose agree word for word, and the sentence cut in three is one sentence", () => {
    expect(fidelity(prose, script)).toMatchObject({ missing: 0, added: 0, ok: true });
    expect(prose).toContain(
      "Ji Ning drew a slow breath and This chapter was stolen from lightnovelpub[dot]net let the sword intent settle in his palm.",
    );
  });

  test("the same boilerplate recurs in the chapters after it, in the prose as in the script", () => {
    for (const id of [SITE_TEXT_CHAPTER, 9, 10, 11]) {
      const c = world.chapters.cliche.find((x) => x.id === id)!;
      expect(world.segments[`cliche:${id}`].filter((s) => s.text === BOILERPLATE)).toHaveLength(1);
      expect(partsText(chapterParts("cliche", id, c)).split(BOILERPLATE)).toHaveLength(2);
    }
  });

  test("a simulated re-script marks it again and still holds every word", async () => {
    const lines = await fakeScriptingProvider().script({
      title: chapter.title,
      target: null,
      cast: [],
      text: prose,
      signal: new AbortController().signal,
    });
    expect(fidelity(prose, lines)).toMatchObject({ missing: 0, added: 0, ok: true });
    expect(lines.filter((l) => l.text === BOILERPLATE).map((l) => l.type)).toEqual(["watermark"]);
    expect(lines.filter((l) => l.type === "note").map((l) => l.text)).toEqual([
      script.find((s) => s.type === "note")!.text,
    ]);
    expect(lines.find((l) => l.text === "Updated first on wuxiabox.com")?.type).toBe("watermark");
  });
});
