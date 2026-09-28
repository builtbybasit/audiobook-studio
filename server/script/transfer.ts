// A book's script written out as a file to keep, send, edit or carry to a newer EPUB of the same
// book. See docs/script-transfer.md#the-file-and-the-export; reading one back is `importPlan.ts`.
import JSZip from "jszip";

import type {
  Character,
  Endpoint,
  LexEntry,
  ScriptFileChapter,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptManifest,
  VoiceHint,
} from "@/types";
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
import { getBook, getChapterBody, listChapters } from "~/db/library";
import { readScript } from "~/db/script";
import { plainText } from "~/epub/markdown";
import { notFound } from "~/lib/errors";
import { wordsOf } from "~/providers/chatScripting";

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

  zip.file("manifest.json", json(manifest));
  zip.file("cast.json", json(readCast(db, bookId).map((c) => speakerOf(c, endpoints))));
  zip.file("lexicon.json", json(readLexicon(db, bookId).map(termOf)));

  const buffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return { name: `${book.title}.script.zip`, bytes: new Uint8Array(buffer) };
}
