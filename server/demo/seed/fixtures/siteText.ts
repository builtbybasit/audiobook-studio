// The words a web-novel source weaves into a chapter that are not the story, as the demo's
// scripts carry them: a site's boilerplate between paragraphs and inside a sentence, a translator's
// note, and the two mistakes the detector is there to catch — an address the model left as story,
// and a line of story it marked as the site's.
//
// They are added to the script, not to the prose, and the prose is composed from the script
// (`world/text.ts`), so the two agree word for word the way a real chapter and its script must: a
// line marked as site text is still a line of the script, which is what lets fidelity hold.
import type { Segment, SegmentType, SiteCheck } from "@/types";
import { wordsOf } from "~/providers/chatScripting";
import { storyWhy } from "~/script/siteCheck";

/** A paragraph of story a model took for boilerplate, for the detector to question. */
const MISTAKEN =
  "“Visit the library pavilion for more chapters of the Sword Manual,” the old librarian had told him, and he had gone every evening since, copying the faded characters by lamplight until the ink ran thin and the night watch called the third hour across the empty courtyard.";

/** The chapter of The Cliché Cultivation World that carries every case at once. */
export const SITE_TEXT_CHAPTER = 8;

/** The line the source drops into chapter after chapter — repeated, as boilerplate is. */
export const BOILERPLATE = "Read the latest chapters at novelbin.com";

interface Insert {
  /** the index, in the script as generated, of the line it follows */
  after: number;
  lines: {
    type: SegmentType;
    text: string;
    siteCheck?: SiteCheck;
    /** the next line continues the same sentence: joined by a space in the prose, not a paragraph */
    runOn?: boolean;
  }[];
}

const INSERTS: Record<string, Record<number, Insert[]>> = {
  cliche: {
    [SITE_TEXT_CHAPTER]: [
      // between two paragraphs
      { after: 2, lines: [{ type: "watermark", text: BOILERPLATE }] },
      {
        after: 5,
        lines: [
          {
            type: "note",
            text: "(TL note: Lan’er is a pet name. The er on the end makes it fond, the way family would say it.)",
          },
        ],
      },
      // inside a sentence: the model cut it into narration, watermark and narration
      {
        after: 9,
        lines: [
          { type: "narration", text: "Ji Ning drew a slow breath and", runOn: true },
          {
            type: "watermark",
            text: "This chapter was stolen from lightnovelpub[dot]net",
            runOn: true,
          },
          { type: "narration", text: "let the sword intent settle in his palm." },
        ],
      },
      // story the model marked as the site's — "for more chapters" sounded like boilerplate — and
      // long enough, with nothing in it that gives a site away, for the detector to doubt the mark
      {
        after: 13,
        lines: [
          {
            type: "watermark",
            text: MISTAKEN,
            siteCheck: { suggest: "narration", why: storyWhy(wordsOf(MISTAKEN).length) },
          },
        ],
      },
      // an address the model left as story
      {
        after: 17,
        lines: [
          {
            type: "narration",
            text: "Updated first on wuxiabox.com",
            siteCheck: { suggest: "watermark", why: "names a web address" },
          },
        ],
      },
    ],
    9: [{ after: 4, lines: [{ type: "watermark", text: BOILERPLATE }] }],
    10: [{ after: 5, lines: [{ type: "watermark", text: BOILERPLATE }] }],
    11: [{ after: 3, lines: [{ type: "watermark", text: BOILERPLATE }] }],
  },
};

/** A script line and whether the prose runs straight on into the next one. */
export interface Drafted {
  segment: Segment;
  runOn: boolean;
}

/**
 * The generated script with this chapter's site text in it, renumbered. Every generated line is
 * kept as it was — its words, speaker and direction — so the chapters without site text, and the
 * lines around it, are exactly what they were before any was added.
 */
export function withSiteText(bookId: string, chapterId: number, segs: Segment[]): Drafted[] {
  const out: Drafted[] = segs.map((segment) => ({ segment, runOn: false }));
  const inserts = INSERTS[bookId]?.[chapterId] ?? [];
  // from the last to the first, so each `after` still names the line it was written against
  for (const { after, lines } of [...inserts].sort((a, b) => b.after - a.after))
    out.splice(
      Math.min(after + 1, out.length),
      0,
      ...lines.map(({ runOn = false, siteCheck, ...line }) => ({
        segment: {
          id: 0,
          speaker: "Narrator",
          direction: "",
          ...line,
          ...(siteCheck ? { siteCheck: { ...siteCheck } } : {}),
          audio: { status: "none" as const, endpoint: null, ms: 0, duration: 0 },
        },
        runOn,
      })),
    );
  out.forEach((d, i) => (d.segment.id = i + 1));
  return out;
}

/** The prose a drafted script reads as: a paragraph a line, but a sentence cut in three is one. */
export const proseOf = (drafted: readonly Drafted[]): string =>
  drafted
    .map((d, i) => d.segment.text + (i < drafted.length - 1 ? (d.runOn ? " " : "\n\n") : ""))
    .join("");
