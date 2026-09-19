// A parsed EPUB becomes a book (or one more volume of one).
//
// This mirrors `src/mock/world/imports.ts` deliberately: the same numbering rules, the same
// `importing` marks, the same "nothing is skipped here" stance. The review the person then works
// through does not know or care which of the two produced what it is showing, and that is the
// point — the demo and the backend put the same shapes on screen.
import type { Book, Chapter, Volume } from "@/types";
import type { ParsedChapter, ParsedEpub } from "~/epub/parse";
import { detectNotices } from "~/epub/notices";

/** The cover gradients a new book is given, in the order they are handed out. */
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

/** The chapter text the import stores, alongside the chapter it belongs to. */
export interface ChapterBody {
  chapterId: number;
  /**
   * The prose, blocks separated by blank lines, with the file's `*italic*` and `**bold**` marked.
   *
   * Marked because import is the last moment it exists: the EPUB is not retained, so a cue the
   * author put in the text is gone for good the second it is dropped. It rides in the string rather
   * than in a column beside it because the string is going to move — lines are edited, split and
   * joined all through scripting — and offsets would not survive the first edit. `plainText` in
   * [text.ts](../epub/text.ts) is what anything that counts, bills or speaks the text reads.
   */
  body: string;
}

export interface AssembledVolume {
  volume: Volume;
  chapters: Chapter[];
  bodies: ChapterBody[];
}

/**
 * Turn parsed chapters into chapters of a volume, numbered from `startAt`.
 *
 * Numbering is continuous across a book's volumes rather than restarting, because everything
 * downstream — script keys, job records, export entries — is keyed by a chapter number that has to
 * stay unique within the book.
 */
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
