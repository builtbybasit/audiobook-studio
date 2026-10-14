// Size check for an EPUB upload before jszip (which trusts stated sizes) reads it. The guard is
// `~/lib/zip`; what is EPUB's own here is which entries are documents and the refusal wording.
import { EpubParseError } from "~/epub/parse";
import { readArchive, type ArchiveLimits, type ArchiveSize } from "~/lib/zip";

export type { ArchiveLimits, ArchiveSize } from "~/lib/zip";

/** Files parsed as documents rather than only carried. */
const DOCUMENT = /\.(x?html?|xml|opf|ncx|svg)$/i;

/**
 * Refuse an upload that unzips past the limits or misstates its sizes. Not a zip:
 * `EpubParseError`. Too big: 413, not diagnosed (EPUBCheck would unzip it all). An entry that
 * won't inflate passes; the review shows it as an unreadable chapter.
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
