// The mock scripting model: it turns a (book, chapter) pair into an attributed script. Deterministic
// on the pair, so the same chapter always produces the same lines — and a re-script that is meant to
// differ says so through `opts` rather than by drawing different randomness.
import { pick, rng } from "../random";
import { BOOK_SEEDS, MINOR_LINES } from "../fixtures/books";
import { DIRECTIONS } from "../fixtures/style";
import type { Segment, SegmentType } from "@/types";

export function generateSegments(
  bookId: string,
  chapterId: number,
  opts: { aliasNoise?: boolean } = {},
): Segment[] {
  // A freshly imported demo book has a runtime id rather than a hand-authored fixture id. It still
  // needs deterministic prose so the complete seeded workflow can be exercised after import.
  const book = BOOK_SEEDS.find((b) => b.id === bookId) ?? BOOK_SEEDS[0];
  const r = rng(bookId.length * 977 + chapterId * 131);
  const speakers = Object.keys(book.dialogue);
  const n = 24 + Math.floor(r() * 14);
  const segs: { type: SegmentType; speaker: string; text: string }[] = [];
  let last: string | null = null;
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.42 || i === 0) {
      // real scripts have long descriptive paragraphs; about a quarter of narration runs 300–1200 chars (mock lines are short, so several are joined)
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
      // occasionally the LLM emits an alias as its own speaker — gives the review UI something to merge
      const aliases = book.cast.find((c) => c.name === who)?.aliases ?? [];
      if (opts.aliasNoise && aliases.length && r() < 0.18) speaker = aliases[0];
      segs.push({ type: "dialogue", speaker, text: pick(book.dialogue[who], r) });
    }
  }
  return segs.map((s, i) => ({
    id: i + 1,
    ...s,
    direction:
      s.type === "narration" ? (r() < 0.3 ? pick(DIRECTIONS, r) : "") : pick(DIRECTIONS, r),
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  }));
}
