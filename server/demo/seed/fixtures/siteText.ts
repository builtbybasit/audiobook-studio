// Web-novel site text in the demo's scripts: boilerplate, a translator's note, and the two
// mistakes the detector catches. Added to the script; the prose is composed from it
// (`world/text.ts`), so the two agree word for word.
import type { Segment, SegmentType, SiteCheck } from "@/types";
import { wordsOf } from "@/lib/gaps";
import { storyWhy } from "~/script/siteCheck";

/** A paragraph of story a model took for boilerplate, for the detector to question. */
const MISTAKEN =
  "“Visit the library pavilion for more chapters of the Sword Manual,” the old librarian had told him, and he had gone every evening since, copying the faded characters by lamplight until the ink ran thin and the night watch called the third hour across the empty courtyard.";

/** The Cliché Cultivation World chapter that carries every case. */
export const SITE_TEXT_CHAPTER = 8;

export const BOILERPLATE = "Read the latest chapters at novelbin.com";

interface Insert {
  /** the index, in the script as generated, of the line it follows */
  after: number;
  lines: {
    type: SegmentType;
    text: string;
    siteCheck?: SiteCheck;
    /** the next line continues the sentence: joined by a space in the prose */
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
      // story the model marked as the site's, long and plain enough for the detector to doubt it
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

export interface Drafted {
  segment: Segment;
  runOn: boolean;
}

/** The generated script with this chapter's site text inserted and renumbered. */
export function withSiteText(bookId: string, chapterId: number, segs: Segment[]): Drafted[] {
  const out: Drafted[] = segs.map((segment) => ({ segment, runOn: false }));
  const inserts = INSERTS[bookId]?.[chapterId] ?? [];
  // last first, so each `after` still names its line
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

/** A paragraph per line, except where `runOn` joins them. */
export const proseOf = (drafted: readonly Drafted[]): string =>
  drafted
    .map((d, i) => d.segment.text + (i < drafted.length - 1 ? (d.runOn ? " " : "\n\n") : ""))
    .join("");
