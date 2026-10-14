// Zip-bomb guard for the EPUB and script imports: an archive's unzipped sizes are checked against
// limits before anything parses it. Declared sizes can lie, so every entry is inflated once here;
// yauzl (unlike jszip) fails an entry whose data runs past its declared size.
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";

import { AppError } from "~/lib/errors";

const MB = 1024 * 1024;

/** A big web novel is a few thousand entries; a million empty ones would exhaust memory. */
const MAX_ENTRIES = 50_000;

export interface ArchiveLimits {
  /** the whole archive unzipped, in bytes */
  total: number;
  /** any one document in it, in bytes */
  document: number;
}

export interface ArchiveSize {
  entries: number;
  bytes: number;
}

export interface ArchiveWording {
  /** "That EPUB has too many files in it" */
  noun: string;
  /** "That file could not be read as an EPUB" */
  asA: string;
  notZip(message: string): Error;
}

export interface ReadArchiveOptions {
  limits: ArchiveLimits;
  /** entries that get parsed, held to `limits.document` */
  document: RegExp;
  wording: ArchiveWording;
  /**
   * Entries whose bytes are handed back (none by default), asked with the declared size so a
   * caller can decline a big one. A number keeps only that many leading bytes, e.g. to sniff a
   * recording's format; the whole entry is still inflated and measured.
   */
  keep?: (name: string, size: number) => boolean | number;
}

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

const tooLarge = (message: string, detail: string): AppError => new AppError(413, message, detail);

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

/**
 * Not a zip: `wording.notZip`. Too big: 413. Inflates past its declared size: 415. An entry that
 * fails to inflate otherwise is skipped; the reader after this one reports it.
 */
export async function readArchive(
  bytes: ArrayBuffer | Uint8Array,
  { limits, document, wording, keep = () => false }: ReadArchiveOptions,
): Promise<{
  size: ArchiveSize;
  entries: ArchiveEntry[];
  names: string[];
  sizes: Map<string, number>;
}> {
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
  const sizes = new Map<string, number>();
  try {
    for await (const entry of zip.eachEntry()) {
      count++;
      const size = entry.uncompressedSize;
      total += size;
      // checked on the declared sizes, before inflating
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
      sizes.set(entry.fileName, size);
      if (!entry.canDecodeFileData()) continue;
      const kept = await inflate(zip, entry, wording, keep(entry.fileName, size));
      if (kept) entries.push({ name: entry.fileName, bytes: kept });
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw notZip(e);
  }
  return { size: { entries: count, bytes: total }, entries, names, sizes };
}

/** Streams an entry so yauzl holds it to its declared size; only the oversize failure is raised. */
async function inflate(
  zip: ZipFile,
  entry: Entry,
  wording: ArchiveWording,
  keep: boolean | number,
): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  // bytes still to keep: all, a head, or none
  let room = keep === true ? Infinity : keep === false ? 0 : Math.max(0, keep);
  try {
    const stream = await zip.openReadStreamPromise(entry);
    for await (const chunk of stream) {
      if (room <= 0) continue;
      const c = chunk as Buffer;
      const part = c.length > room ? c.subarray(0, room) : c;
      chunks.push(part);
      room -= part.length;
    }
  } catch (e) {
    // yauzl tells this case apart only by message: "too many bytes in the stream. expected …"
    if (/^too many bytes/i.test(reason(e)))
      throw new AppError(
        415,
        `That file could not be read as ${wording.asA}`,
        `${entry.fileName} inflates to more than the ${mb(entry.uncompressedSize)} the archive says it is.`,
      );
    return undefined;
  }
  return keep === false ? undefined : new Uint8Array(Buffer.concat(chunks));
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : "");
