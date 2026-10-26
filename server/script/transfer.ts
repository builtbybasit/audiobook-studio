// A book's script written out as a file to keep, send, edit or carry to a newer EPUB of the same
// book. Reading one back is `importPlan.ts`.
import { existsSync } from "node:fs";

import JSZip from "jszip";

import type {
  Book,
  Character,
  Effect,
  Endpoint,
  KeptSample,
  LexEntry,
  ScriptExportSamples,
  ScriptFileBook,
  ScriptFileChapter,
  ScriptFileEffect,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptFileVoice,
  ScriptManifest,
  VoiceHint,
} from "@/types";
import { wordsOf } from "@/lib/gaps";
import {
  BOOK_FILE,
  chapterFileName,
  EFFECTS_FILE,
  SCRIPT_CHAPTER_FORMAT,
  SCRIPT_FORMAT,
  SCRIPT_FORMAT_VERSION,
  toFileLine,
} from "@/lib/scriptFile";
import { readCast, readLexicon } from "~/db/cast";
import type { Db } from "~/db/client";
import { listEffects } from "~/db/effects";
import { readEndpoints } from "~/db/endpoints";
import { readCarried } from "~/db/voiceSamples";
import { chapterRecap, getBook, getChapterBody, listChapters } from "~/db/library";
import { readScript } from "~/db/script";
import { plainText } from "~/epub/markdown";
import { notFound } from "~/lib/errors";
import { SAMPLES_MANIFEST, VOICE_SAMPLES_FORMAT } from "~/speakerSamples/folder";
import { readSpeakerSamplesForExport } from "~/speakerSamples/store";
import type { VoiceFiles } from "~/voices/files";

/**
 * Fingerprint of a chapter's source words (not its script lines, which can't rebuild it): sha256
 * over `wordsOf`, so markup, quotes and spacing don't matter but a fixed typo does. Export and
 * import must share this one function.
 */
export function sourceHash(body: string): { hash: string; words: number } {
  const words = wordsOf(plainText(body));
  const hex = new Bun.CryptoHasher("sha256").update(words.join(" ")).digest("hex");
  return { hash: `sha256:${hex}`, words: words.length };
}

/**
 * How another install can recognise a voice: provider host, voice id and label. Not the
 * `VoiceRef`, whose endpoint id is local to this database.
 */
export function voiceHint(
  ref: string | null | undefined,
  endpoints: readonly Endpoint[],
): VoiceHint | undefined {
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

/** One recording a speaker's voice would carry. */
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

/** Recordings that came in a script file and still wait with a speaker, to be carried again. */
function waitingVoices(db: Db, bookId: string, audioDir: string): CarriedVoice[] {
  return readSpeakerSamplesForExport(db, bookId, audioDir);
}

/**
 * The kept recordings of the clone a speaker is voiced by; none if the voice is gone. A recording
 * gone from disk is left out, as `readSpeakerSamplesForExport` leaves one out.
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
    samples: clone.samples.flatMap((s) => {
      const path = files?.path(endpointId, voiceId, s.file);
      if (!path || !existsSync(path)) return [];
      return [
        { name: s.name, format: s.format, bytes: s.bytes, read: () => Bun.file(path).bytes() },
      ];
    }),
  };
}

/** Speakers whose recordings an export can carry: their clone's, else ones left by an import. */
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

/** What "Include voice samples" would add to this book's export, shown before it is ticked. */
export function exportSamples(
  db: Db,
  bookId: string,
  audioDir: string,
  voices?: VoiceFiles,
): ScriptExportSamples {
  if (!getBook(db, bookId)) throw notFound("There is no book by that id");
  return {
    voices: carriedVoices(db, bookId, audioDir, voices).map((v) => ({
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

/** Effect ids as the file names them: by name, `"none"` as itself; a dead id is dropped. */
type EffectNames = (id: string) => string | undefined;

function speakerOf(
  c: Character,
  endpoints: readonly Endpoint[],
  effectName: EffectNames,
): ScriptFileSpeaker {
  const out: ScriptFileSpeaker = {
    name: c.name,
    aliases: c.aliases,
    gender: c.gender,
    description: c.description,
    style: c.style,
    color: c.color,
    major: c.major,
  };
  if (c.personaOf) out.personaOf = c.personaOf;
  if (c.masked) out.masked = true;
  if (c.age) out.age = c.age;
  if (c.voiceType) out.voiceType = c.voiceType;
  if (c.speed != null) out.speed = c.speed;
  const voice = voiceHint(c.voice, endpoints);
  if (voice) out.voice = voice;
  const effect = c.effect && effectName(c.effect);
  if (effect) out.effect = effect;
  const thoughts = c.thoughts && effectName(c.thoughts);
  if (thoughts) out.thoughts = thoughts;
  return out;
}

/** The settings the book has of its own; one following the library's default is left out. */
function bookOf(book: Book, endpoints: readonly Endpoint[], effectName: EffectNames) {
  const out: ScriptFileBook = {};
  if (book.pacing) out.pacing = book.pacing;
  if (book.prompt) out.prompt = book.prompt;
  if (book.readNotes != null) out.readNotes = book.readNotes;
  const thoughts = book.thoughts && effectName(book.thoughts);
  if (thoughts) out.thoughts = thoughts;
  const cv = book.characterVoice;
  if (cv) {
    out.characterVoice = { by: cv.by };
    for (const slot of ["one", "male", "female", "other"] as const) {
      const hint = voiceHint(cv[slot], endpoints);
      if (hint) out.characterVoice[slot] = hint;
    }
    const ages = (cv.ages ?? []).flatMap(({ slot, age, voice }) => {
      const hint = voiceHint(voice, endpoints);
      return hint ? [{ slot, age, voice: hint }] : [];
    });
    if (ages.length) out.characterVoice.ages = ages;
  }
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
 * The book's script as `<book>.script.zip`. Every scripted chapter goes, excluded or not: exclusion
 * is the importing book's call. Indented JSON, since people edit these files by hand.
 */
export async function buildScriptExport(
  db: Db,
  bookId: string,
  { samples }: { samples?: { voices?: VoiceFiles; audioDir: string } } = {},
): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }> {
  const book = getBook(db, bookId);
  if (!book) throw notFound("There is no book by that id");
  const endpoints = readEndpoints(db);
  const library = new Map(listEffects(db).map((e) => [e.id, e]));
  // every effect the file names, so `effects.json` defines exactly those
  const used = new Map<string, Effect>();
  const effectName: EffectNames = (id) => {
    if (id === "none") return id;
    const effect = library.get(id);
    if (effect) used.set(id, effect);
    return effect?.name;
  };

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
      lines: segments.map((s) => toFileLine(s, effectName)),
    };
    const recap = chapterRecap(db, bookId, chapter.id);
    if (recap) doc.recap = recap;
    zip.file(file, json(doc));
    manifest.chapters.push({ file, title: chapter.title, sourceHash: hash, words });
  }

  // Recordings go only when asked for. Stored, not deflated: audio barely compresses.
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
        const speaker = speakerOf(c, endpoints, effectName);
        const folder = folders.get(c.name);
        if (folder) speaker.samples = folder;
        return speaker;
      }),
    ),
  );
  zip.file("lexicon.json", json(readLexicon(db, bookId).map(termOf)));
  zip.file(BOOK_FILE, json(bookOf(book, endpoints, effectName)));
  // last, once lines, speakers and the book have named theirs; in library order
  zip.file(
    EFFECTS_FILE,
    json(
      [...library.values()]
        .filter((e) => used.has(e.id))
        .map(({ name, chain, useWhen }): ScriptFileEffect =>
          useWhen ? { name, chain, useWhen } : { name, chain },
        ),
    ),
  );

  const buffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return { name: `${book.title}.script.zip`, bytes: new Uint8Array(buffer) };
}
