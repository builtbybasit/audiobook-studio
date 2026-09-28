// What an EPUB upload unzips to, measured before anything reads it.
//
// An EPUB is a zip, and the EPUB library unzips it with jszip, which believes whatever sizes the
// archive states. So the upload goes through the shared guard in `~/lib/zip` first, which holds
// every entry to the size it declared and refuses what this server will not hold. What is EPUB's
// own here is which entries count as documents and how a refusal is worded.
import { EpubParseError } from "~/epub/parse";
import { readArchive, type ArchiveLimits, type ArchiveSize } from "~/lib/zip";

export type { ArchiveLimits, ArchiveSize } from "~/lib/zip";

/** The files that are parsed as a document, rather than only carried: the chapters above all. */
const DOCUMENT = /\.(x?html?|xml|opf|ncx|svg)$/i;

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
  const { size } = await readArchive(bytes, {
    limits,
    document: DOCUMENT,
    wording: { noun: "EPUB", asA: "an EPUB", notZip: (message) => new EpubParseError(message) },
  });
  return size;
}
