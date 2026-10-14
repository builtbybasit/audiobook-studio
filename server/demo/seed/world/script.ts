// The mock scripting model, deterministic on (book, chapter); a re-script that should differ says
// so through `opts`. Site text is added after the story lines are drawn (`fixtures/siteText.ts`).
import { pick, rng } from "~/demo/seed/random";
import { BOOK_SEEDS, MINOR_LINES } from "~/demo/seed/fixtures/books";
import { proseOf, withSiteText, type Drafted } from "~/demo/seed/fixtures/siteText";
import { DIRECTIONS } from "~/demo/seed/fixtures/style";
import type { Segment, SegmentType } from "@/types";

type Options = { aliasNoise?: boolean };

export const generateSegments = (
  bookId: string,
  chapterId: number,
  opts: Options = {},
): Segment[] => draftScript(bookId, chapterId, opts).map((d) => d.segment);

export const generateProse = (bookId: string, chapterId: number): string =>
  proseOf(draftScript(bookId, chapterId));

function draftScript(bookId: string, chapterId: number, opts: Options = {}): Drafted[] {
  // an imported demo book has a runtime id; fall back so it still gets deterministic prose
  const book = BOOK_SEEDS.find((b) => b.id === bookId) ?? BOOK_SEEDS[0];
  const r = rng(bookId.length * 977 + chapterId * 131);
  const speakers = Object.keys(book.dialogue);
  const n = 24 + Math.floor(r() * 14);
  const segs: { type: SegmentType; speaker: string; text: string }[] = [];
  let last: string | null = null;
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.42 || i === 0) {
      // about a quarter of narration runs 300–1200 chars, as in real scripts
      const paras = r() < 0.25 ? 3 + Math.floor(r() * 10) : 1;
      segs.push({
        type: "narration",
        speaker: "Narrator",
        text: Array.from({ length: paras }, () => pick(book.narration, r)).join(" "),
      });
    } else if (roll < 0.55) {
      const who = pick(Object.keys(book.thought), r);
      segs.push({ type: "thought", speaker: who, text: pick(book.thought[who], r) });
    } else if (roll < 0.66 && book.minor.length) {
      const [who] =
        book.minor[
          Math.floor(r() * Math.min(book.minor.length, 4 + (chapterId % book.minor.length)))
        ];
      segs.push({ type: "dialogue", speaker: who, text: pick(MINOR_LINES, r) });
    } else {
      let who = pick(speakers, r);
      if (who === last) who = pick(speakers, r);
      last = who;
      let speaker = who;
      // occasionally an alias as its own speaker, for the review UI to merge
      const aliases = book.cast.find((c) => c.name === who)?.aliases ?? [];
      if (opts.aliasNoise && aliases.length && r() < 0.18) speaker = aliases[0];
      segs.push({ type: "dialogue", speaker, text: pick(book.dialogue[who], r) });
    }
  }
  const story: Segment[] = segs.map((s, i) => ({
    id: i + 1,
    ...s,
    direction:
      s.type === "narration" ? (r() < 0.3 ? pick(DIRECTIONS, r) : "") : pick(DIRECTIONS, r),
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  }));
  return withSiteText(book.id, chapterId, story);
}
