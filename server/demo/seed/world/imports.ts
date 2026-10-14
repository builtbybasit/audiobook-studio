// A demo import sample as the import leaves it: chapters numbered on across volumes, notes on
// non-story chapters, nothing skipped (the review decides).
import { narrator } from "@/lib/cast";
import { importSample, type VolumeSpec } from "~/demo/seed/fixtures/imports";
import { noteOf } from "~/demo/seed/fixtures/notices";
import type { ShelfBook } from "~/demo/seed/fixtures/shelf";
import { voiceRef } from "~/demo/seed/fixtures/voices";
import { rng } from "~/demo/seed/random";
import type { Book, Chapter, Volume, World } from "@/types";

export interface ImportedBook {
  book: Book;
  chapters: Chapter[];
}

function wordsOf(spec: VolumeSpec["chapters"][number], r: () => number): number {
  if (spec.words) return spec.words;
  if (!spec.kind || spec.kind === "title") return 2200 + Math.floor(r() * 2400);
  if (spec.kind === "mixed") return 2400 + Math.floor(r() * 2000);
  return 90 + Math.floor(r() * 320);
}

export function importedChapters(
  volume: VolumeSpec,
  volumeId: number,
  startAt: number,
  seed: number,
): Chapter[] {
  const r = rng(seed);
  return volume.chapters.map((spec, i): Chapter => {
    const c: Chapter = {
      id: startAt + i,
      index: startAt + i,
      volumeId,
      volumeIndex: i + 1,
      title: spec.title,
      words: wordsOf(spec, r),
      scripting: "none",
      scriptingProgress: 0,
      narration: "none",
      narrationProgress: 0,
      duration: 0,
    };
    if (spec.kind) c.note = noteOf(spec.kind, spec.at, spec.variant);
    return c;
  });
}

export function importedBook(sampleId: string, id: string): ImportedBook {
  const sample = importSample(sampleId) ?? importSample("clean")!;
  const volumes: Volume[] = [];
  const chapters: Chapter[] = [];
  let from = 1;
  sample.volumes.forEach((v, i) => {
    const vol: Volume = {
      id: i + 1,
      name: v.name,
      file: v.file,
      from,
      to: from + v.chapters.length - 1,
    };
    volumes.push(vol);
    chapters.push(...importedChapters(v, vol.id, from, 7 + i * 13 + sampleId.length));
    from += v.chapters.length;
  });
  return {
    book: {
      id,
      title: sample.title,
      author: sample.author,
      cover: sample.cover,
      addedAt: "just now",
      volumes,
      importing: true,
      sample: sample.id,
    },
    chapters,
  };
}

export type LocalLibrary = Pick<World, "books" | "chapters" | "characters" | "endpoints">;

/**
 * Adds the sample under `id` (or `import-<sample>`, numbered on when taken), awaiting review, with
 * the Narrator on the first enabled voice. Returns the book's id.
 */
export function importInto(
  library: LocalLibrary,
  sample: string,
  { id, file, title }: { id?: string; file?: string; title?: string } = {},
): string {
  const base = id ?? `import-${sample}`;
  let bookId = base;
  for (let n = 2; library.books.some((b) => b.id === bookId); n++) bookId = `${base}-${n}`;
  const { book, chapters } = importedBook(sample, bookId);
  if (title?.trim()) book.title = title.trim();
  if (file) book.volumes[0].file = file;
  library.books.push(book);
  library.chapters[bookId] = chapters;
  const voiced = library.endpoints.find((e) => e.enabled && e.voices.length);
  library.characters[bookId] = [narrator(voiced ? voiceRef(voiced.id, voiced.voices[0].id) : null)];
  return bookId;
}

/** Adds a book with its review done. Returns the book's id. */
export function shelveInto(library: LocalLibrary, spec: ShelfBook): string {
  const id = importInto(library, spec.sample, { id: spec.id, title: spec.title });
  const book = library.books.find((b) => b.id === id)!;
  book.author = spec.author;
  book.cover = spec.cover;
  book.addedAt = spec.addedAt;
  delete book.importing;
  return id;
}
