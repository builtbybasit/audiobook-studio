// What an uploaded zip unzips to, measured before anything reads it.
//
// The upload limit is on the compressed file: 80 KB of zip can inflate to 80 MB of chapter, which
// whatever reads it then holds as a string, parses and converts. Measured on an EPUB, that was a
// gigabyte and a half and seventeen seconds with nothing else served, from a file a sixtieth of the
// upload limit. So an archive is read here first, with yauzl, and refused when what it would become
// is more than this server will hold. The EPUB import and the script import both come through here,
// each with its own idea of which entries are documents and its own words for the refusal.
//
// **The sizes are trusted because they are checked.** A zip states each entry's unzipped size in
// its central directory, and it can lie. jszip believes the entry and inflates whatever is there;
// yauzl instead fails an entry the moment its data runs past the size it declared. So every entry
// is inflated once here — a chunk at a time — and an archive that gets through has entries exactly
// as big as it said, which is what the limits were measured against.
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";

import { AppError } from "~/lib/errors";

const MB = 1024 * 1024;

/**
 * How many entries an archive may have. A thousand-chapter web novel is two or three thousand
 * files with its images; each entry is an object a reader keeps for the whole import, so a zip of
 * a million empty files is its own way to run out of memory.
 */
const MAX_ENTRIES = 50_000;

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

/** How a refusal names the file, so an EPUB and a script file are each told in their own words. */
export interface ArchiveWording {
  /** "EPUB", "script file" — as in "That EPUB has too many files in it" */
  noun: string;
  /** "an EPUB" — as in "That file could not be read as an EPUB" */
  asA: string;
  /** what a file that is not a zip at all is thrown as, so each import explains it its own way */
  notZip(message: string): Error;
}

export interface ReadArchiveOptions {
  limits: ArchiveLimits;
  /** the entries parsed as a document rather than only carried, held to `limits.document` */
  document: RegExp;
  wording: ArchiveWording;
  /** the entries whose bytes are handed back; the rest are inflated into nothing. None by default. */
  keep?: (name: string) => boolean;
}

/** One entry the caller asked to keep, as it unzipped. */
export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

const tooLarge = (message: string, detail: string): AppError => new AppError(413, message, detail);

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Refuse an upload that unzips to more than the limits, or that misstates what it unzips to, and
 * hand back the entries `keep` asked for — with the name of every file in it, kept or not.
 *
 * A file that is not a zip at all is thrown as `wording.notZip`. One that is a zip and is too big
 * is a 413; one that inflates past what it declared is a 415.
 *
 * An entry whose data will not inflate for any other reason is let through and not kept. The
 * reader after this one fails the same entry, and says which.
 */
export async function readArchive(
  bytes: ArrayBuffer | Uint8Array,
  { limits, document, wording, keep = () => false }: ReadArchiveOptions,
): Promise<{ size: ArchiveSize; entries: ArchiveEntry[]; names: string[] }> {
  const notZip = (e: unknown): Error =>
    wording.notZip(`This file is not a readable zip archive. ${reason(e)}`.trim());
  let zip;
  try {
    zip = await fromBufferPromise(Buffer.from(bytes as ArrayBuffer));
  } catch (e) {
    throw notZip(e);
  }

  if (zip.entryCount > MAX_ENTRIES)
    throw tooLarge(
      `That ${wording.noun} has too many files in it`,
      `It holds ${zip.entryCount.toLocaleString("en")} files; a book of a few thousand chapters holds a few thousand.`,
    );

  let total = 0;
  let count = 0;
  const entries: ArchiveEntry[] = [];
  const names: string[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      count++;
      const size = entry.uncompressedSize;
      total += size;
      // Refused on the stated sizes, before a byte of this entry is inflated.
      if (document.test(entry.fileName) && size > limits.document)
        throw tooLarge(
          `A file inside that ${wording.noun} is too large to read`,
          `${entry.fileName} unzips to ${mb(size)}, over the ${mb(limits.document)} limit on one document. Raise MAX_DOCUMENT_MB if this is a file you expect to import.`,
        );
      if (total > limits.total)
        throw tooLarge(
          `That ${wording.noun} unzips to more than this server will read`,
          `It holds over ${mb(total)} once unzipped, over the ${mb(limits.total)} limit. Raise MAX_UNZIPPED_MB if this is a file you expect to import.`,
        );
      if (entry.fileName.endsWith("/")) continue;
      names.push(entry.fileName);
      if (!entry.canDecodeFileData()) continue;
      const kept = await inflate(zip, entry, wording, keep(entry.fileName));
      if (kept) entries.push({ name: entry.fileName, bytes: kept });
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw notZip(e);
  }
  return { size: { entries: count, bytes: total }, entries, names };
}

/**
 * Inflate one entry, so that yauzl can hold it to the size it declared — into nothing, or into
 * the bytes handed back when the caller keeps it.
 *
 * Chunk by chunk, so no more of a discarded entry is in memory at once than zlib hands over. The
 * one failure that matters is the one yauzl raises when the data runs past the declared size — the
 * lie the limits above would otherwise have believed. Anything else wrong with the data is the
 * reader's to find, one entry at a time.
 */
async function inflate(
  zip: ZipFile,
  entry: Entry,
  wording: ArchiveWording,
  keep: boolean,
): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  try {
    const stream = await zip.openReadStreamPromise(entry);
    for await (const chunk of stream) if (keep) chunks.push(chunk as Buffer);
  } catch (e) {
    // yauzl's wording, and the only way it tells this case apart: "too many bytes in the stream.
    // expected 1000. got at least 16384".
    if (/^too many bytes/i.test(reason(e)))
      throw new AppError(
        415,
        `That file could not be read as ${wording.asA}`,
        `${entry.fileName} inflates to more than the ${mb(entry.uncompressedSize)} the archive says it is.`,
      );
    return undefined;
  }
  return keep ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : "");
