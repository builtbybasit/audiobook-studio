// An EPUB as it stands the moment the import has read it: a book (or one more volume of one), its
// chapters in reading order with continuous numbering, and the notes the import attached to the
// chapters that did not look like story. Nothing is skipped here — every chapter arrives included
// and the review is where the person decides.
import { importSample, type VolumeSpec } from "../fixtures/imports";
import { noteOf } from "../fixtures/notices";
import { rng } from "../random";
import type { Book, Chapter, Volume } from "@/types";

export interface ImportedBook {
  book: Book;
  chapters: Chapter[];
}

/** The word count a chapter reports: notices are short, story is not, a mixed chapter is story plus a note. */
function wordsOf(spec: VolumeSpec["chapters"][number], r: () => number): number {
  if (spec.words) return spec.words;
  if (!spec.kind || spec.kind === "title") return 2200 + Math.floor(r() * 2400);
  if (spec.kind === "mixed") return 2400 + Math.floor(r() * 2000);
  return 90 + Math.floor(r() * 320);
}

/** Expand one volume's chapter specs into chapters numbered from `startAt`. */
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

/** A whole book from one sample, ready to be reviewed. */
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

/** One more volume for an existing book: the sample's first volume, numbered after the book's last chapter. */
export function importedVolume(
  sampleId: string,
  volumeId: number,
  startAt: number,
  name: string,
  file: string,
): { volume: Volume; chapters: Chapter[] } {
  const sample = importSample(sampleId) ?? importSample("volumes")!;
  const spec = sample.volumes[sample.volumes.length > 1 ? 1 : 0];
  const chapters = importedChapters(spec, volumeId, startAt, 11 + volumeId * 17);
  return {
    volume: {
      id: volumeId,
      name,
      file,
      from: startAt,
      to: startAt + chapters.length - 1,
      importing: true,
    },
    chapters,
  };
}
