// Plans a script-file import without writing anything; the page writes only what the person ticks.
// Chapters pair on `sourceHash` (the words the script was made from), never titles or numbers.
// Reading the file is `scriptFile.ts`.
import type {
  Character,
  CharacterVoice,
  Endpoint,
  ExpressionTag,
  FoundVoice,
  ImportChapter,
  LexEntry,
  RefusedChapter,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptImportPlan,
  SpeakerDetails,
  TermDetails,
  VoiceHint,
  VoiceMatch,
  VoiceRow,
} from "@/types";
import { isFishAudio } from "@/lib/endpointShapes";
import { fromFileLine, readMarkers } from "@/lib/scriptFile";
import { readCast, readLexicon } from "~/db/cast";
import type { Db } from "~/db/client";
import { readEndpoints } from "~/db/endpoints";
import { getBook, getChapterBody, listChapters } from "~/db/library";
import { plainText } from "~/epub/markdown";
import { notFound } from "~/lib/errors";
import { deliveryFor } from "~/narration/cost";
import { fidelity } from "~/providers/chatScripting";
import { speechTarget } from "~/providers/target";
import { endpointVoiceLister, type VoiceLister, type VoiceQuery } from "~/providers/voices";
import { readScriptFile, type ReadFile, type ScriptUpload } from "~/script/scriptFile";
import { sourceHash } from "~/script/transfer";
import {
  folderOf,
  judgeVoiceFolder,
  rowSamples,
  SAMPLE_LIMITS,
  type SampleLimits,
} from "~/speakerSamples/folder";

/** Provider lookups for voices this install lacks. Listing is free; the real lister is default. */
export interface ImportPorts {
  voices?: VoiceLister;
  signal?: AbortSignal;
  /** total budget for all voice lookups */
  lookupMs?: number;
  /** the clone route's limits by default */
  sampleLimits?: SampleLimits;
}

/** Read, check and match `upload` against `bookId`'s chapters. */
export async function planScriptImport(
  db: Db,
  bookId: string,
  upload: ScriptUpload,
  ports: ImportPorts = {},
): Promise<ScriptImportPlan> {
  const book = getBook(db, bookId);
  if (!book) throw notFound("There is no book by that id", `id: ${bookId}`);
  const limits = ports.sampleLimits ?? SAMPLE_LIMITS;
  const file = await readScriptFile(upload, limits);

  const cast = readCast(db, bookId);
  const endpoints = readEndpoints(db);
  const tagsFor = tagsOf(cast, book.characterVoice, endpoints);

  const { chapters, refused } = matchChapters(db, bookId, file.chapters, tagsFor);
  refused.push(...file.refused);
  refused.sort((a, b) => a.file.localeCompare(b.file));

  return {
    title: file.manifest?.title ?? "",
    author: file.manifest?.author ?? "",
    name: upload.name,
    chapters,
    refused,
    ignored: file.ignored,
    cast: castDiff(cast, file.cast),
    lexicon: lexiconDiff(readLexicon(db, bookId), file.lexicon),
    voices: await voiceRows(db, cast, endpoints, file, ports, limits),
  };
}

// ---------- matching ----------

/** A speaker's expression tags: those of the endpoint their voice is on. */
function tagsOf(
  cast: Character[],
  characterVoice: CharacterVoice | undefined,
  endpoints: readonly Endpoint[],
): (speaker: string) => readonly ExpressionTag[] {
  const delivery = deliveryFor(cast, characterVoice);
  return (speaker) => {
    const id = delivery(speaker).endpoint;
    return endpoints.find((e) => e.id === id)?.expressions?.tags ?? [];
  };
}

function matchChapters(
  db: Db,
  bookId: string,
  files: ReadFile["chapters"],
  tagsFor: (speaker: string) => readonly ExpressionTag[],
): { chapters: ImportChapter[]; refused: RefusedChapter[] } {
  // Each fingerprint's chapters in reading order, so two identical author's notes pair in order.
  const byHash = new Map<string, { id: number; title: string; body: string }[]>();
  for (const ch of listChapters(db, bookId)) {
    const body = getChapterBody(db, bookId, ch.id);
    if (body === undefined) continue;
    const { hash } = sourceHash(body);
    (byHash.get(hash) ?? byHash.set(hash, []).get(hash)!).push({
      id: ch.id,
      title: ch.title,
      body,
    });
  }

  const chapters: ImportChapter[] = [];
  const refused: RefusedChapter[] = [];
  for (const { file, chapter } of files) {
    const refusal = (reason: RefusedChapter["reason"], detail: string): void => {
      refused.push({ file, title: chapter.title, words: chapter.words, reason, detail });
    };
    const target = byHash.get(chapter.sourceHash)?.shift();
    if (!target) {
      refusal(
        "unmatched",
        "No chapter of this book has these words. The EPUB may have changed it, or the script is from another book.",
      );
      continue;
    }
    // The same bar a model's answer clears: an honest correction passes, a rewritten scene does not.
    const lines = chapter.lines.map((l) => ({ text: readMarkers(l.text).text }));
    const check = fidelity(plainText(target.body), lines);
    if (!check.ok) {
      refusal(
        "fidelity",
        `The lines differ from the chapter by ${check.missing} missing and ${check.added} added words${
          check.examples.length ? ` (missing: ${check.examples.join(", ")})` : ""
        }; at most 2% may.`,
      );
      continue;
    }
    let annotation = 0;
    const next = (): number => ++annotation;
    chapters.push({
      chapterId: target.id,
      title: target.title,
      fileTitle: chapter.title,
      file,
      segments: chapter.lines.map((l, i) => fromFileLine(l, i + 1, tagsFor(l.speaker), next)),
    });
  }
  chapters.sort((a, b) => a.chapterId - b.chapterId);
  return { chapters, refused };
}

// ---------- the cast and the dictionary ----------

const detailsOf = (c: {
  gender: SpeakerDetails["gender"];
  description: string;
  style: string;
}) => ({
  gender: c.gender,
  description: c.description,
  style: c.style,
});

const sameDetails = (a: SpeakerDetails, b: SpeakerDetails): boolean =>
  a.gender === b.gender && a.description === b.description && a.style === b.style;

/** Add what the book lacks, keep what it has, and union the aliases, which only ever adds matches. */
function castDiff(cast: Character[], file: ScriptFileSpeaker[]): ScriptImportPlan["cast"] {
  const out: ScriptImportPlan["cast"] = { add: [], differ: [], aliases: [] };
  for (const speaker of file) {
    const have = cast.find((c) => c.name === speaker.name);
    if (!have) {
      out.add.push(speaker);
      continue;
    }
    const book = detailsOf(have);
    const theirs = detailsOf(speaker);
    if (!sameDetails(book, theirs)) out.differ.push({ name: speaker.name, book, file: theirs });
    const known = new Set([have.name, ...have.aliases]);
    const add = [...new Set(speaker.aliases)].filter((a) => !known.has(a));
    if (add.length) out.aliases.push({ name: speaker.name, add });
  }
  return out;
}

const termDetails = (t: ScriptFileTerm | LexEntry): TermDetails => {
  const d: TermDetails = { say: t.say, enabled: t.enabled };
  if (t.ipa) d.ipa = t.ipa;
  if (t.note) d.note = t.note;
  if (t.matchCase) d.matchCase = true;
  return d;
};

const sameTerm = (a: TermDetails, b: TermDetails): boolean =>
  a.say === b.say &&
  (a.ipa ?? "") === (b.ipa ?? "") &&
  (a.note ?? "") === (b.note ?? "") &&
  !!a.matchCase === !!b.matchCase &&
  a.enabled === b.enabled;

function lexiconDiff(book: LexEntry[], file: ScriptFileTerm[]): ScriptImportPlan["lexicon"] {
  const out: ScriptImportPlan["lexicon"] = { add: [], differ: [] };
  for (const term of file) {
    const have = book.find((e) => e.term === term.term);
    if (!have) {
      if (!out.add.some((t) => t.term === term.term)) out.add.push(term);
      continue;
    }
    const mine = termDetails(have);
    const theirs = termDetails(term);
    if (!sameTerm(mine, theirs)) out.differ.push({ term: term.term, book: mine, file: theirs });
  }
  return out;
}

// ---------- voices ----------

/** The host a voice hint names its provider by, as the export writes it. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

const LOOKUP_MS = 15_000;

type Lookup = { voices: FoundVoice[] } | { failed: string };

/**
 * One row per speaker whose voice the file names. A match needs the same host, id and label.
 * Pre-ticked only for a new speaker or one on the Narrator's voice. All lookups share one deadline;
 * a failed or timed-out lookup is `unchecked`, never `private`.
 */
async function voiceRows(
  db: Db,
  cast: Character[],
  endpoints: readonly Endpoint[],
  read: ReadFile,
  ports: ImportPorts,
  limits: SampleLimits,
): Promise<VoiceRow[]> {
  const enabled = endpoints.filter((e) => e.enabled);
  const lister = ports.voices ?? endpointVoiceLister();
  const deadline = AbortSignal.timeout(ports.lookupMs ?? LOOKUP_MS);
  const signal = ports.signal ? AbortSignal.any([ports.signal, deadline]) : deadline;
  const lookups = new Map<string, Promise<Lookup>>();
  const ask = (e: Endpoint, query: VoiceQuery): Promise<Lookup> => {
    const key = `${e.id}\u0000${query.source}\u0000${query.query ?? ""}`;
    let found = lookups.get(key);
    if (!found) {
      found = listSafely(lister, speechTarget(db, e), query, signal);
      lookups.set(key, found);
    }
    return found;
  };

  const rows = await Promise.all(
    read.cast.map(async (speaker): Promise<VoiceRow | null> => {
      const hint = speaker.voice;
      if (!hint) return null;
      const have = cast.find((c) => c.name === speaker.name);
      const current = have?.voice ?? null;
      const isNew = !have;
      const same = enabled.filter((e) => hostOf(e.baseUrl) === hint.provider);
      const match = await matchVoice(hint, same, ask);
      const usable = match.kind === "here" || match.kind === "public";
      const row: VoiceRow = {
        speaker: speaker.name,
        isNew,
        current,
        hint,
        match,
        ticked: (isNew || current === null) && usable,
      };
      // The file's recordings for this voice, to clone it again from.
      const folder = folderOf(speaker.samples);
      if (folder) row.samples = rowSamples(judgeVoiceFolder(folder, read.voices, limits));
      return row;
    }),
  );
  return rows.filter((r): r is VoiceRow => r !== null);
}

async function matchVoice(
  hint: VoiceHint,
  endpoints: readonly Endpoint[],
  ask: (e: Endpoint, query: VoiceQuery) => Promise<Lookup>,
): Promise<VoiceMatch> {
  const options = endpoints.flatMap((e) =>
    e.voices.some((v) => v.id === hint.voiceId && v.label === hint.voiceLabel)
      ? [{ endpointId: e.id, endpointName: e.name, ref: `${e.id}/${hint.voiceId}` }]
      : [],
  );
  if (options.length) return { kind: "here", options };

  // Not here yet: can the provider hand it over (its library, or Fish's public catalogue by id)?
  const same = (v: FoundVoice): boolean => v.id === hint.voiceId && v.label === hint.voiceLabel;
  let failed: string | undefined;
  for (const e of endpoints) {
    // only Fish has a public catalogue
    const queries: VoiceQuery[] = [{ source: "library" }];
    if (isFishAudio(e)) queries.push({ source: "public", query: hint.voiceId });
    for (const query of queries) {
      const answer = await ask(e, query);
      if ("failed" in answer) {
        failed ??= `${e.name} could not be asked: ${answer.failed}`;
        continue;
      }
      const found = answer.voices.find(same);
      if (found) {
        const { sample: _sample, ...voice } = found;
        return { kind: "public", endpointId: e.id, endpointName: e.name, voice };
      }
    }
  }
  return failed ? { kind: "unchecked", reason: failed } : { kind: "private" };
}

async function listSafely(
  lister: VoiceLister,
  target: Parameters<VoiceLister["list"]>[0],
  query: VoiceQuery,
  signal: AbortSignal,
): Promise<Lookup> {
  if (signal.aborted) return { failed: "the lookup ran out of time" };
  try {
    // Raced too, so a lister that ignores the signal can't hold the import.
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    return { voices: (await Promise.race([lister.list(target, query, signal), aborted])).voices };
  } catch (e) {
    if (signal.aborted) return { failed: "the lookup ran out of time" };
    return { failed: e instanceof Error && e.message ? e.message : "it refused" };
  }
}
