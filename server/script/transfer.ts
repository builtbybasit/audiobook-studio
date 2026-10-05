// A book's script written out as a file to keep, send, edit or carry to a newer EPUB of the same
// book. See docs/script-transfer.md#the-file-and-the-export; reading one back is `importPlan.ts`.
import JSZip from "jszip";

import type {
  Character,
  Endpoint,
  KeptSample,
  LexEntry,
  ScriptExportSamples,
  ScriptFileChapter,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptFileVoice,
  ScriptManifest,
  VoiceHint,
} from "@/types";
import { wordsOf } from "@/lib/gaps";
import {
  chapterFileName,
  SCRIPT_CHAPTER_FORMAT,
  SCRIPT_FORMAT,
  SCRIPT_FORMAT_VERSION,
  toFileLine,
} from "@/lib/scriptFile";
import { readCast, readLexicon } from "~/db/cast";
import type { Db } from "~/db/client";
import { readEndpoints } from "~/db/endpoints";
import { readCarried } from "~/db/voiceSamples";
import { getBook, getChapterBody, listChapters } from "~/db/library";
import { readScript } from "~/db/script";
import { plainText } from "~/epub/markdown";
import { notFound } from "~/lib/errors";
import { SAMPLES_MANIFEST, VOICE_SAMPLES_FORMAT } from "~/speakerSamples/folder";
import { readSpeakerSamplesForExport } from "~/speakerSamples/store";
import type { VoiceFiles } from "~/voices/files";

/**
 * Which chapter of a book a script belongs to, told by the words of its source.
 *
 * **The source, never the lines.** A script cannot rebuild its chapter: the scripting model drops
 * the quotation marks around dialogue and squashes whitespace, its answer is accepted with 2% of
 * words missing or added, and the reader's rewrite changes words on purpose. So this is sha256
 * over the chapter's own words in reading order, read through `wordsOf` — the same normalisation
 * the answer check uses — so a re-imported EPUB that differs only in markup, curly quotes or
 * spacing still matches, and one corrected typo does not.
 *
 * **One function, called by export and import both.** Two copies of the normalisation would drift
 * until every chapter was refused.
 */
export function sourceHash(body: string): { hash: string; words: number } {
  const words = wordsOf(plainText(body));
  const hex = new Bun.CryptoHasher("sha256").update(words.join(" ")).digest("hex");
  return { hash: `sha256:${hex}`, words: words.length };
}

/**
 * How another install can recognise a voice: the provider's host, the voice's id and label.
 *
 * A `VoiceRef` is never written, because its endpoint id is a key local to this database. A voice
 * on an endpoint that no longer has it writes no hint — there is nothing left to recognise.
 */
function voiceHint(ref: string | null, endpoints: readonly Endpoint[]): VoiceHint | undefined {
  if (!ref) return undefined;
  const slash = ref.indexOf("/");
  if (slash < 0) return undefined;
  const endpoint = endpoints.find((e) => e.id === ref.slice(0, slash));
  const voice = endpoint?.voices.find((v) => v.id === ref.slice(slash + 1));
  if (!endpoint || !voice) return undefined;
  let provider: string;
  try {
    provider = new URL(endpoint.baseUrl).host;
  } catch {
    provider = endpoint.baseUrl;
  }
  return { endpoint: endpoint.name, provider, voiceId: voice.id, voiceLabel: voice.label };
}

// ---------- voice samples ----------

/** One recording a speaker's voice would carry: what it is, and how to read its bytes. */
interface CarriedSample {
  name: string;
  format: KeptSample["format"];
  bytes: number;
  read(): Promise<Uint8Array>;
}

/** A speaker whose voice's recordings an export can carry. */
interface CarriedVoice {
  speaker: string;
  title: string;
  samples: CarriedSample[];
}

/**
 * Recordings that came in a script file and still wait with a speaker, to be carried again. A
 * discarded set is not carried.
 */
function waitingVoices(db: Db, bookId: string, audioDir: string): CarriedVoice[] {
  return readSpeakerSamplesForExport(db, bookId, audioDir);
}

/**
 * The recordings slice 2 keeps for the clone a speaker is voiced by — or none, when the voice is
 * not a clone with recordings, its recordings were forgotten, or the voice has left the saved
 * configuration (`missing_since`), since a voice that is gone is not one this book speaks with.
 */
function keptCloneOf(
  db: Db,
  c: Character,
  endpoints: readonly Endpoint[],
  files: VoiceFiles | undefined,
): CarriedVoice | undefined {
  if (!c.voice || !voiceHint(c.voice, endpoints)) return undefined;
  const slash = c.voice.indexOf("/");
  const endpointId = c.voice.slice(0, slash);
  const voiceId = c.voice.slice(slash + 1);
  const clone = readCarried(db, endpointId, voiceId);
  if (!clone?.samples.length) return undefined;
  return {
    speaker: c.name,
    title: clone.title,
    samples: clone.samples.map((s) => ({
      name: s.name,
      format: s.format,
      bytes: s.bytes,
      read: async () => {
        const path = files?.path(endpointId, voiceId, s.file);
        if (!path) throw new Error(`No recording kept as ${s.file}`);
        return Bun.file(path).bytes();
      },
    })),
  };
}

/**
 * Every speaker of the book whose voice's recordings an export can carry: the clone the speaker is
 * voiced by, or failing that the recordings still waiting with them from an earlier import.
 */
function carriedVoices(
  db: Db,
  bookId: string,
  audioDir: string,
  files?: VoiceFiles,
): CarriedVoice[] {
  const endpoints = readEndpoints(db);
  const waiting = new Map(waitingVoices(db, bookId, audioDir).map((w) => [w.speaker, w]));
  const out: CarriedVoice[] = [];
  for (const c of readCast(db, bookId)) {
    const voice = keptCloneOf(db, c, endpoints, files) ?? waiting.get(c.name);
    if (voice?.samples.length) out.push(voice);
  }
  return out;
}

/**
 * What ticking "Include voice samples" would add to this book's export, so the option can say
 * whose recordings it hands over and how much before anyone ticks it. Empty when there are none.
 */
export function exportSamples(db: Db, bookId: string, audioDir: string): ScriptExportSamples {
  if (!getBook(db, bookId)) throw notFound("There is no book by that id");
  return {
    voices: carriedVoices(db, bookId, audioDir).map((v) => ({
      speaker: v.speaker,
      title: v.title,
      count: v.samples.length,
      bytes: v.samples.reduce((n, s) => n + s.bytes, 0),
    })),
  };
}

/** A folder name for a speaker's recordings: readable, and unique within the file. */
function folderOf(speaker: string, taken: Set<string>): string {
  const base =
    speaker
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "voice";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return `voices/${slug}/`;
}

function speakerOf(c: Character, endpoints: readonly Endpoint[]): ScriptFileSpeaker {
  const out: ScriptFileSpeaker = {
    name: c.name,
    aliases: c.aliases,
    gender: c.gender,
    description: c.description,
    style: c.style,
    color: c.color,
    major: c.major,
  };
  const voice = voiceHint(c.voice, endpoints);
  if (voice) out.voice = voice;
  return out;
}

function termOf(e: LexEntry): ScriptFileTerm {
  const out: ScriptFileTerm = { term: e.term, say: e.say, enabled: e.enabled };
  if (e.ipa) out.ipa = e.ipa;
  if (e.note) out.note = e.note;
  if (e.matchCase) out.matchCase = true;
  return out;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/**
 * The book's script as `<book>.script.zip`.
 *
 * **Every chapter with a script, excluded or not.** Exclusion is the importing book's decision, made
 * on its own Contents page; a script left out here could not be got back there. A chapter with no
 * script writes no file, and one whose run is still going is written as it last stood. Indented
 * JSON, because a person opening a chapter file to fix its speakers is one of the reasons it exists.
 */
export async function buildScriptExport(
  db: Db,
  bookId: string,
  { samples }: { samples?: { voices?: VoiceFiles; audioDir: string } } = {},
): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }> {
  const book = getBook(db, bookId);
  if (!book) throw notFound("There is no book by that id");
  const endpoints = readEndpoints(db);

  const zip = new JSZip();
  const manifest: ScriptManifest = {
    format: SCRIPT_FORMAT,
    version: SCRIPT_FORMAT_VERSION,
    title: book.title,
    author: book.author,
    chapters: [],
  };
  let position = 0;
  for (const chapter of listChapters(db, bookId)) {
    const segments = readScript(db, bookId, chapter.index);
    if (!segments.length) continue;
    const { hash, words } = sourceHash(getChapterBody(db, bookId, chapter.index) ?? "");
    const file = chapterFileName(++position, chapter.title);
    const doc: ScriptFileChapter = {
      format: SCRIPT_CHAPTER_FORMAT,
      version: SCRIPT_FORMAT_VERSION,
      title: chapter.title,
      sourceHash: hash,
      words,
      lines: segments.map(toFileLine),
    };
    zip.file(file, json(doc));
    manifest.chapters.push({ file, title: chapter.title, sourceHash: hash, words });
  }

  // Recordings of a person go only when asked for, every time: `samples` is the ask. Stored rather
  // than deflated — audio barely compresses, and inflating it on the other side is time for nothing.
  const folders = new Map<string, string>();
  if (samples) {
    const taken = new Set<string>();
    for (const v of carriedVoices(db, bookId, samples.audioDir, samples.voices)) {
      const folder = folderOf(v.speaker, taken);
      const record: ScriptFileVoice = {
        format: VOICE_SAMPLES_FORMAT,
        version: 1,
        title: v.title,
        samples: [],
      };
      for (const [i, s] of v.samples.entries()) {
        const file = `sample-${i + 1}.${s.format}`;
        zip.file(folder + file, await s.read(), { compression: "STORE" });
        record.samples.push({ file, name: s.name, format: s.format });
      }
      zip.file(folder + SAMPLES_MANIFEST, json(record));
      folders.set(v.speaker, folder);
    }
  }

  zip.file("manifest.json", json(manifest));
  zip.file(
    "cast.json",
    json(
      readCast(db, bookId).map((c) => {
        const speaker = speakerOf(c, endpoints);
        const folder = folders.get(c.name);
        if (folder) speaker.samples = folder;
        return speaker;
      }),
    ),
  );
  zip.file("lexicon.json", json(readLexicon(db, bookId).map(termOf)));

  const buffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return { name: `${book.title}.script.zip`, bytes: new Uint8Array(buffer) };
}
