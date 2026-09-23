// What an upload unzips to, measured before anything reads it.
//
// The upload limit is on the compressed file, and an EPUB is a zip: 80 KB of it can inflate to
// 80 MB of chapter, which the EPUB library then holds as a string, parses into a DOM and turns
// into Markdown. Measured, that was a gigabyte and a half and seventeen seconds with nothing else
// served, from a file a sixtieth of the upload limit. So the archive is read here first, with
// yauzl, and refused when what it would become is more than this server will hold.
//
// **The sizes are trusted because they are checked.** A zip states each entry's unzipped size in
// its central directory, and it can lie. The EPUB library unzips with jszip, which believes the
// entry and inflates whatever is there. yauzl instead fails an entry the moment its data runs past
// the size it declared. So every entry is inflated once here — into nothing, a chunk at a time —
// and an archive that gets through has entries exactly as big as it said, which is what the
// limits were measured against.
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";

import { AppError } from "~/lib/errors";
import { EpubParseError } from "~/epub/parse";

const MB = 1024 * 1024;

/**
 * How many entries an archive may have. A thousand-chapter web novel is two or three thousand
 * files with its images; each entry is an object the EPUB library keeps for the whole import, so
 * a zip of a million empty files is its own way to run out of memory.
 */
const MAX_ENTRIES = 50_000;

/** The files that are parsed as a document, rather than only carried: the chapters above all. */
const DOCUMENT = /\.(x?html?|xml|opf|ncx|svg)$/i;

export interface ArchiveLimits {
  /** everything in the archive, unzipped, in bytes */
  total: number;
  /** any one document in it — a chapter file, the package, the navigation — in bytes */
  document: number;
}

/** What the archive turned out to hold, for the import's log line. */
export interface ArchiveSize {
  entries: number;
  bytes: number;
}

const tooLarge = (message: string, detail: string): AppError => new AppError(413, message, detail);

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Refuse an upload that unzips to more than the limits, or that misstates what it unzips to.
 *
 * A file that is not a zip at all is an `EpubParseError`, so the import explains it the way it
 * explains any other file it cannot open. One that is a zip and is too big is a 413, and is not
 * handed to EPUBCheck for a diagnosis: the validator unzips the whole thing too, and a diagnosis
 * that costs what the refusal was protecting is no courtesy.
 *
 * An entry whose data will not inflate is let through. The EPUB library fails the same entry, and
 * a damaged chapter is one the review shows as unreadable rather than a reason to lose the book.
 */
export async function checkArchive(
  bytes: ArrayBuffer,
  limits: ArchiveLimits,
): Promise<ArchiveSize> {
  let zip;
  try {
    zip = await fromBufferPromise(Buffer.from(bytes));
  } catch (e) {
    throw new EpubParseError(`This file is not a readable zip archive. ${reason(e)}`.trim());
  }

  if (zip.entryCount > MAX_ENTRIES)
    throw tooLarge(
      "That EPUB has too many files in it",
      `It holds ${zip.entryCount.toLocaleString("en")} files; a book of a few thousand chapters holds a few thousand.`,
    );

  let total = 0;
  let entries = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      entries++;
      const size = entry.uncompressedSize;
      total += size;
      // Refused on the stated sizes, before a byte of this entry is inflated.
      if (DOCUMENT.test(entry.fileName) && size > limits.document)
        throw tooLarge(
          "A file inside that EPUB is too large to read",
          `${entry.fileName} unzips to ${mb(size)}, over the ${mb(limits.document)} limit on one document. Raise MAX_DOCUMENT_MB if this is a file you expect to import.`,
        );
      if (total > limits.total)
        throw tooLarge(
          "That EPUB unzips to more than this server will read",
          `It holds over ${mb(total)} once unzipped, over the ${mb(limits.total)} limit. Raise MAX_UNZIPPED_MB if this is a file you expect to import.`,
        );
      if (entry.fileName.endsWith("/") || !entry.canDecodeFileData()) continue;
      await inflate(zip, entry);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new EpubParseError(`This file is not a readable zip archive. ${reason(e)}`.trim());
  }
  return { entries, bytes: total };
}

/**
 * Inflate one entry into nothing, so that yauzl can hold it to the size it declared.
 *
 * Chunk by chunk, so no more of it is in memory at once than zlib hands over. The one failure that
 * matters is the one yauzl raises when the data runs past the declared size — the lie the limits
 * above would otherwise have believed. Anything else wrong with the data is the EPUB library's to
 * find, one chapter at a time.
 */
async function inflate(zip: ZipFile, entry: Entry): Promise<void> {
  try {
    const stream = await zip.openReadStreamPromise(entry);
    for await (const _ of stream);
  } catch (e) {
    // yauzl's wording, and the only way it tells this case apart: "too many bytes in the stream.
    // expected 1000. got at least 16384".
    if (/^too many bytes/i.test(reason(e)))
      throw new AppError(
        415,
        "That file could not be read as an EPUB",
        `${entry.fileName} inflates to more than the ${mb(entry.uncompressedSize)} the archive says it is.`,
      );
  }
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : "");
