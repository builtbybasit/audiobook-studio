// A line as a script file holds it: expression tags written into the words as markers and read
// back to the same annotations, and a chapter that comes back with the signature it left with.
// See docs/script-transfer.md#the-file-and-the-export.
import { describe, expect, test } from "bun:test";

import type { ExpressionAnnotation, ExpressionTag, Segment } from "@/types";
import {
  chapterFileName,
  fromFileLine,
  MarkerError,
  readMarkers,
  toFileLine,
  writeMarkers,
} from "@/lib/scriptFile";
import { scriptSignature } from "@/lib/scriptHistory";

const SIGH: ExpressionTag = { id: "sigh", label: "Sigh", token: "(sighs)", kind: "sound" };
const WHISPER: ExpressionTag = {
  id: "whisper",
  label: "Whisper",
  token: "[whispering]",
  kind: "delivery",
};
const TAGS = [SIGH, WHISPER];

let nextId = 0;
const at = (
  tag: ExpressionTag,
  pos: number,
  more: Partial<ExpressionAnnotation> = {},
): ExpressionAnnotation => ({ ...tag, annotationId: ++nextId, at: pos, ...more });

describe("markers", () => {
  test.each<[string, string, ExpressionAnnotation[], string]>([
    ["no tags", "Don't move.", [], "Don't move."],
    ["a tag at the start", "Don't move.", [at(SIGH, 0)], "{sigh} Don't move."],
    ["a tag glued to the end of a word", "Don't move.", [at(SIGH, 5)], "Don't{sigh} move."],
    ["a line that starts with a space", " Go.", [at(SIGH, 0)], "{sigh}  Go."],
    ["a tag after a double space", "Go  now.", [at(SIGH, 4)], "Go  {sigh} now."],
    ["a tag at the end", "Don't move.", [at(SIGH, 11)], "Don't move.{sigh}"],
    [
      "two at one position keep their order",
      "Don't move.",
      [at(WHISPER, 6), at(SIGH, 6)],
      "Don't {whisper} {sigh} move.",
    ],
    ["an omitted tag", "Go.", [at(SIGH, 0, { omitted: true })], "{sigh!} Go."],
    ["a tag awaiting review", "Go.", [at(SIGH, 0, { needsReview: true })], "{sigh?} Go."],
    [
      "omitted and awaiting review",
      "Go.",
      [at(SIGH, 0, { omitted: true, needsReview: true })],
      "{sigh!?} Go.",
    ],
    ["a literal brace in the book", "[Skill {rank}] gained.", [], "[Skill {{rank}] gained."],
    ["a brace beside a tag", "{x}", [at(SIGH, 1)], "{{{sigh}x}"],
    [
      "a tag id made of marker characters",
      "Go.",
      [at({ ...SIGH, id: "huh?" }, 0), at({ ...SIGH, id: "a}b{c!\\" }, 0, { omitted: true })],
      "{huh\\?} {a\\}b\\{c\\!\\\\!} Go.",
    ],
  ])("%s", (_, text, expressions, marked) => {
    expect(writeMarkers(text, expressions)).toBe(marked);
    const back = readMarkers(marked);
    expect(back.text).toBe(text);
    expect(back.marks).toEqual(
      expressions.map((a) => ({
        id: a.id,
        at: a.at,
        ...(a.omitted ? { omitted: true } : {}),
        ...(a.needsReview ? { needsReview: true } : {}),
      })),
    );
  });

  test("a marker typed without its space reads the same", () => {
    expect(readMarkers("{sigh}Don't move.")).toEqual(readMarkers("{sigh} Don't move."));
  });

  test.each([
    ["an unclosed marker", "Don't {sigh move.", 6],
    ["a marker opened inside another", "Go {sigh {whisper} now.", 3],
    ["an empty marker", "Go {} now.", 3],
  ])("%s is refused with where it broke", (_, marked, where) => {
    const refused = (() => {
      try {
        readMarkers(marked);
      } catch (e) {
        return e;
      }
    })();
    expect(refused).toBeInstanceOf(MarkerError);
    expect((refused as MarkerError).at).toBe(where);
  });
});

describe("lines", () => {
  const line = (s: Partial<Segment> & Pick<Segment, "id" | "text">): Segment => ({
    type: "narration",
    speaker: "Narrator",
    direction: "",
    audio: { status: "done", endpoint: "fish", ms: 900, duration: 2.1, url: "/x.wav" },
    ...s,
  });
  const chapter: Segment[] = [
    line({ id: 1, text: "The ledger lay open on the table.", sep: "\n\n" }),
    line({
      id: 2,
      type: "dialogue",
      speaker: "Mara",
      direction: "tense",
      text: "We are short again.",
      expressions: [at(SIGH, 0), at(WHISPER, 7, { omitted: true })],
      pause: 0.6,
      edited: true,
    }),
    line({
      id: 3,
      text: "Nobody answered her.",
      fallback: true,
      fallbackCount: 2,
      fallbackMismatch: "3 words missing",
    }),
  ];

  test("a chapter comes back with the signature it left with, and none of this install", () => {
    let n = 100;
    const back = chapter.map((s, i) => fromFileLine(toFileLine(s), i + 1, TAGS, () => ++n));
    expect(scriptSignature(back)).toBe(scriptSignature(chapter));
    // the clip, the ids and the provider tokens were never in the file
    const written = JSON.stringify(chapter.map(toFileLine));
    for (const local of ["audio", "annotationId", "(sighs)", '"id"'])
      expect(written).not.toContain(local);
    expect(back[1].expressions?.map((a) => [a.label, a.token, a.annotationId])).toEqual([
      ["Sigh", "(sighs)", 101],
      ["Whisper", "[whispering]", 102],
    ]);
    expect(back.every((s) => s.audio.status === "none")).toBe(true);
  });

  test("a tag the speaking endpoint does not offer is kept, awaiting review", () => {
    const s = fromFileLine(
      { speaker: "Mara", type: "dialogue", text: "{growl}Out." },
      1,
      TAGS,
      () => 1,
    );
    expect(s.text).toBe("Out.");
    expect(s.expressions).toEqual([
      {
        id: "growl",
        label: "growl",
        token: "",
        kind: "delivery",
        annotationId: 1,
        at: 0,
        needsReview: true,
      },
    ]);
  });
});

test.each([
  [12, "12 · The Gate", "chapters/0012-12-the-gate.json"],
  [1, "Pokémon’s Rest", "chapters/0001-pokemons-rest.json"],
  [3, "第三章", "chapters/0003-chapter.json"],
])("chapter %i %s is filed as %s", (position, title, name) => {
  expect(chapterFileName(position, title)).toBe(name);
});
