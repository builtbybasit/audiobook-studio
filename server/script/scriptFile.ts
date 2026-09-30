// A script file read into its parts, and refused when it cannot be one. See
// docs/script-transfer.md#import.
//
// Two callers read a file this way: the import plan (`importPlan.ts`), which matches what it finds
// against a book and writes nothing, and the voice samples' route (`~/speakerSamples/store`), which
// reads the same file again when an import is applied, to keep the recordings it carries. Both go
// through the same guard on what the zip unzips to and the same schemas, so a file the plan showed
// is a file the apply step reads the same way.
import * as v from "valibot";

import type {
  RefusedChapter,
  ScriptFileChapter,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptManifest,
} from "@/types";
import { MarkerError, readMarkers, SCRIPT_CHAPTER_FORMAT, SCRIPT_FORMAT } from "@/lib/scriptFile";
import { env } from "~/env";
import { AppError } from "~/lib/errors";
import {
  CastFileSchema,
  LexiconFileSchema,
  ScriptChapterSchema,
  ScriptManifestSchema,
} from "~/lib/schemas";
import { readArchive } from "~/lib/zip";
import {
  folderOf,
  SAMPLE_LIMITS,
  type FolderEntry,
  type SampleLimits,
} from "~/speakerSamples/folder";

/** An uploaded script file: a `<book>.script.zip`, or one chapter's `.json` on its own. */
export interface ScriptUpload {
  /** the file's name as the browser sent it, which history's "Imported from …" reads */
  name: string;
  bytes: Uint8Array;
}

export interface ReadFile {
  manifest?: ScriptManifest;
  /** the chapter files that parsed, in the order their names sort — the export numbers them */
  chapters: { file: string; chapter: ScriptFileChapter }[];
  /** the chapter files that did not */
  refused: RefusedChapter[];
  cast: ScriptFileSpeaker[];
  lexicon: ScriptFileTerm[];
  ignored: string[];
  /**
   * Every file under `voices/`, by its path relative to the manifest, with its size — and its bytes
   * when it was small enough to be worth keeping. Judged a folder at a time by what the cast names.
   */
  voices: Map<string, FolderEntry>;
  /** the folder the manifest sits in, which every other path is read from — `""` at the top */
  root: string;
}

/**
 * How much of each recording a read holds. A plan needs to know what a recording is, not to hold
 * it, so by default only its first bytes are kept — enough for `sniffSample` — and its size is
 * the one the zip guard measured. Keeping recordings is the voice samples' route's job, and it
 * asks for whole ones only in the folders it is keeping, named by their path in the zip.
 */
export type RecordingReads = "head" | { whole(path: string): boolean };

/** What `sniffSample` reads of a recording; comfortably more than any header it looks for. */
export const SNIFF_BYTES = 4096;

const refuse = (message: string, detail?: string): AppError => new AppError(400, message, detail);

/** A zip starts with a local file header, `PK\x03\x04` — or `PK\x05\x06` when it is empty. */
const isZip = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;

/**
 * Read an upload into its parts, refusing what cannot be a script file. The voice samples' route
 * reads the same file again when the import is applied, and comes through here too.
 */
export async function readScriptFile(
  upload: ScriptUpload,
  limits: SampleLimits = SAMPLE_LIMITS,
  recordings: RecordingReads = "head",
): Promise<ReadFile> {
  if (!isZip(upload.bytes)) return readLoneChapter(upload);

  const { entries, names, sizes } = await readArchive(upload.bytes, {
    limits: {
      total: env.MAX_UNZIPPED_MB * 1024 * 1024,
      document: env.MAX_DOCUMENT_MB * 1024 * 1024,
    },
    document: /\.json$/i,
    wording: {
      noun: "script file",
      asA: "a script file",
      notZip: (message) =>
        new AppError(415, "That file could not be read as a script file", message),
    },
    // A recording over the limit on one is refused by its size alone, so it is never inflated
    // into memory to be refused; the rest are held as a head unless this read keeps them whole.
    keep: (name, size) => {
      if (junk(name)) return false;
      if (/\.json$/i.test(name)) return true;
      if (!VOICES.test(name) || size > limits.clip) return false;
      return recordings !== "head" && recordings.whole(name) ? true : SNIFF_BYTES;
    },
  });
  const partial = new Set(
    recordings === "head"
      ? names.filter((n) => VOICES.test(n) && !/\.json$/i.test(n))
      : names.filter((n) => VOICES.test(n) && !/\.json$/i.test(n) && !recordings.whole(n)),
  );
  return readZip(
    entries,
    entries.map((e) => e.name),
    names.filter((n) => !junk(n)),
    sizes,
    partial,
  );
}

/** A file in a `voices/` folder, wherever the manifest sits. */
const VOICES = /(^|\/)voices\//;

/**
 * What a hand-made zip picks up on the way: Finder's `__MACOSX/` resource forks and `._` files,
 * and the `.DS_Store` a folder leaves behind. Skipped without a word — nobody put them there.
 */
function junk(name: string): boolean {
  const parts = name.split("/");
  const base = parts.at(-1) ?? "";
  return parts.includes("__MACOSX") || base.startsWith("._") || base === ".DS_Store";
}

function readZip(
  entries: { name: string; bytes: Uint8Array }[],
  kept: string[],
  all: string[],
  sizes: ReadonlyMap<string, number>,
  partial: ReadonlySet<string>,
): ReadFile {
  // Finder's Compress wraps everything in a folder, so the manifest is wherever it is shallowest
  // and every other path is read from there.
  const manifests = kept.filter((n) => n.split("/").at(-1) === "manifest.json");
  if (!manifests.length)
    throw refuse(
      "That zip is not a script file",
      "It has no manifest.json. Export a script from the book menu, or import one chapter's .json on its own.",
    );
  const depth = (n: string): number => n.split("/").length;
  const shallowest = Math.min(...manifests.map(depth));
  const top = manifests.filter((n) => depth(n) === shallowest);
  if (top.length > 1)
    throw refuse(
      "That zip holds more than one script",
      `It has ${top.map((n) => n).join(" and ")}. Import them one at a time.`,
    );
  const manifestName = top[0];
  const root = manifestName.slice(0, manifestName.length - "manifest.json".length);
  const bytesOf = new Map(entries.map((e) => [e.name, e.bytes]));

  const manifestJson = parseJson(bytesOf.get(manifestName)!);
  if (!isRecord(manifestJson) || manifestJson.format !== SCRIPT_FORMAT)
    throw refuse(
      "That zip is not a script file",
      `${manifestName} does not say it is one (format "${SCRIPT_FORMAT}").`,
    );
  const manifest = v.safeParse(ScriptManifestSchema, manifestJson);
  if (!manifest.success)
    throw refuse("That script file's manifest could not be read", issuesOf(manifest.issues));

  const read: ReadFile = {
    manifest: manifest.output,
    chapters: [],
    refused: [],
    cast: [],
    lexicon: [],
    ignored: [],
    voices: new Map(),
    root,
  };

  const castName = `${root}cast.json`;
  const lexiconName = `${root}lexicon.json`;
  const chapterDir = `${root}chapters/`;
  const voiceDir = `${root}voices/`;
  const voiceFiles: string[] = [];
  for (const name of [...all].sort()) {
    if (name === manifestName) continue;
    const bytes = bytesOf.get(name);
    if (name.startsWith(voiceDir)) {
      const at = name.slice(root.length);
      read.voices.set(at, {
        size: sizes.get(name) ?? 0,
        ...(bytes ? { bytes } : {}),
        ...(bytes && partial.has(name) ? { partial: true } : {}),
      });
      voiceFiles.push(at);
      continue;
    }
    if (name === castName && bytes) {
      read.cast = parseWhole(CastFileSchema, bytes, "cast.json");
      continue;
    }
    if (name === lexiconName && bytes) {
      read.lexicon = parseWhole(LexiconFileSchema, bytes, "lexicon.json");
      continue;
    }
    const rest = name.startsWith(chapterDir) ? name.slice(chapterDir.length) : "";
    if (rest && !rest.includes("/") && /\.json$/i.test(rest)) {
      const file = name.slice(root.length);
      // Named as a chapter but with nothing inflated: the zip's data for it is damaged, which is a
      // chapter refused, not a stray file nobody meant to send.
      if (!bytes) {
        read.refused.push({
          file,
          title: "",
          words: 0,
          reason: "malformed",
          detail: "It could not be unzipped; the zip's data for it is damaged.",
        });
        continue;
      }
      const chapter = parseChapter(file, bytes);
      if ("reason" in chapter) read.refused.push(chapter);
      else read.chapters.push({ file, chapter });
      continue;
    }
    read.ignored.push(name.startsWith(root) ? name.slice(root.length) : name);
  }
  // A voice's folder is read because the cast names it; one nobody names is a stray.
  const named = read.cast.flatMap((c) => folderOf(c.samples) ?? []);
  for (const at of voiceFiles)
    if (!named.some((folder) => at.startsWith(folder))) read.ignored.push(at);
  read.ignored.sort();
  return read;
}

/** One chapter's `.json`, dragged out of a zip or edited on its own. */
function readLoneChapter(upload: ScriptUpload): ReadFile {
  const json = parseJsonOr(upload.bytes);
  const format = isRecord(json) ? json.format : undefined;
  if (format === SCRIPT_FORMAT)
    throw refuse(
      "That is a script's manifest, with no chapters in it",
      "Import the whole .script.zip, or one chapter's .json from its chapters folder.",
    );
  if (format !== SCRIPT_CHAPTER_FORMAT)
    throw new AppError(
      415,
      "That file is not a script file",
      "Import a .script.zip exported from the book menu, or one chapter's .json from inside one.",
    );
  const chapter = parseChapter(upload.name, upload.bytes);
  const read: ReadFile = {
    chapters: [],
    refused: [],
    cast: [],
    lexicon: [],
    ignored: [],
    voices: new Map(),
    root: "",
  };
  if ("reason" in chapter) read.refused.push(chapter);
  else read.chapters.push({ file: upload.name, chapter });
  return read;
}

/** A chapter file checked against its schema, or refused by name with the path that broke. */
function parseChapter(file: string, bytes: Uint8Array): ScriptFileChapter | RefusedChapter {
  const json = parseJsonOr(bytes);
  const malformed = (detail: string): RefusedChapter => ({
    file,
    title: isRecord(json) && typeof json.title === "string" ? json.title : "",
    words: isRecord(json) && typeof json.words === "number" ? json.words : 0,
    reason: "malformed",
    detail,
  });
  if (json === undefined) return malformed("It is not valid JSON.");
  const parsed = v.safeParse(ScriptChapterSchema, json);
  if (!parsed.success) return malformed(issuesOf(parsed.issues));
  for (const [i, line] of parsed.output.lines.entries())
    try {
      readMarkers(line.text);
    } catch (e) {
      if (e instanceof MarkerError) return malformed(`lines.${i}.text: ${e.message}`);
      throw e;
    }
  return parsed.output;
}

/** `cast.json` or `lexicon.json`: read whole, or the import is refused saying which. */
function parseWhole<T>(schema: v.GenericSchema<unknown, T>, bytes: Uint8Array, name: string): T {
  const json = parseJsonOr(bytes);
  if (json === undefined) throw refuse(`That script file's ${name} is not valid JSON`);
  const parsed = v.safeParse(schema, json);
  if (!parsed.success)
    throw refuse(`That script file's ${name} could not be read`, issuesOf(parsed.issues));
  return parsed.output;
}

const decoder = new TextDecoder("utf-8");

function parseJson(bytes: Uint8Array): unknown {
  const json = parseJsonOr(bytes);
  if (json === undefined) throw refuse("That script file's manifest is not valid JSON");
  return json;
}

/** The JSON in `bytes`, byte-order mark and all, or undefined when it is not JSON. */
function parseJsonOr(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes).replace(/^﻿/, "")) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** `lines.3.speaker: Invalid type` — where the file broke, in the file's own terms. */
function issuesOf(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .slice(0, 3)
    .map((i) => [v.getDotPath(i), i.message].filter(Boolean).join(": "))
    .join("; ");
}
