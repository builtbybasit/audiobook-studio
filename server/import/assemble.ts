// A parsed EPUB becomes a book (or one more volume of one). Mirrors
// `server/demo/seed/world/imports.ts` on purpose, so the review sees the same shapes from either.
import type { Book, Chapter, Volume } from "@/types";
import type { ParsedChapter, ParsedEpub } from "~/epub/parse";
import { detectNotices } from "~/epub/notices";

const COVERS: [string, string][] = [
  ["#1e3a8a", "#312e81"],
  ["#7f1d1d", "#431407"],
  ["#064e3b", "#134e4a"],
  ["#581c87", "#1e1b4b"],
  ["#7c2d12", "#78350f"],
  ["#0c4a6e", "#164e63"],
];

export const coverFor = (seed: string): [string, string] => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COVERS[h % COVERS.length];
};

export interface ChapterBody {
  chapterId: number;
  /**
   * Blocks separated by blank lines, with `*italic*` and `**bold**` marked inline: the EPUB isn't
   * kept, and offsets wouldn't survive edits. Counting, billing and speech read `plainText`
   * ([text.ts](../epub/text.ts)).
   */
  body: string;
}

export interface AssembledVolume {
  volume: Volume;
  chapters: Chapter[];
  bodies: ChapterBody[];
}

/** Numbered from `startAt`: chapter numbers stay unique across a book's volumes. */
export function assembleVolume(
  parsed: readonly ParsedChapter[],
  volumeId: number,
  startAt: number,
  { name, file, importing = true }: { name: string; file: string; importing?: boolean },
): AssembledVolume {
  const notes = detectNotices(parsed);
  const chapters: Chapter[] = parsed.map((p, i) => {
    const c: Chapter = {
      id: startAt + i,
      index: startAt + i,
      volumeId,
      volumeIndex: i + 1,
      title: p.title,
      words: p.words,
      scripting: "none",
      scriptingProgress: 0,
      narration: "none",
      narrationProgress: 0,
      duration: 0,
    };
    const note = notes[i];
    if (note) c.note = note;
    return c;
  });
  return {
    volume: {
      id: volumeId,
      name,
      file,
      from: startAt,
      to: startAt + Math.max(0, parsed.length - 1),
      ...(importing ? { importing: true } : {}),
    },
    chapters,
    bodies: chapters.map((c, i) => ({ chapterId: c.id, body: parsed[i].text })),
  };
}

/** A whole book from one EPUB, waiting for its contents review. */
export function assembleBook(
  parsed: ParsedEpub,
  bookId: string,
  file: string,
  { title, addedAt = Date.now() }: { title?: string; addedAt?: number } = {},
): { book: Book; chapters: Chapter[]; bodies: ChapterBody[] } {
  const { volume, chapters, bodies } = assembleVolume(parsed.chapters, 1, 1, {
    name: "Vol. 1",
    file,
    importing: true,
  });
  return {
    book: {
      id: bookId,
      title: title?.trim() || parsed.title,
      author: parsed.author,
      cover: coverFor(bookId),
      addedAt: new Date(addedAt).toISOString().slice(0, 10),
      volumes: [volume],
      importing: true,
    },
    chapters,
    bodies,
  };
}
