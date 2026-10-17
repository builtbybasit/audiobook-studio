// Plans a script-file import without writing anything; the page writes only what the person ticks.
// Chapters pair on `sourceHash` (the words the script was made from), else on the lines reading
// a chapter closely (`pairing.ts`); never on titles or numbers.
// Reading the file is `scriptFile.ts`.
import type {
  Book,
  Character,
  CharacterVoice,
  Effect,
  Endpoint,
  ExpressionTag,
  FoundVoice,
  ImportBookSettings,
  ImportChapter,
  LexEntry,
  RefusedChapter,
  ScriptFileBook,
  ScriptFileLine,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptImportPlan,
  Segment,
  SpeakerDetails,
  TermDetails,
  VoiceHint,
  VoiceMatch,
  VoiceRow,
} from "@/types";
import { isFishAudio } from "@/lib/endpointShapes";
import { wordsOf } from "@/lib/gaps";
import { fromFileLine, NEW_EFFECT } from "@/lib/scriptFile";
import { readCast, readLexicon } from "~/db/cast";
import type { Db } from "~/db/client";
import { listEffects } from "~/db/effects";
import { readEndpoints } from "~/db/endpoints";
import { chapterRecap, getBook, getChapterBody, listChapters } from "~/db/library";
import { plainText } from "~/epub/markdown";
import { notFound } from "~/lib/errors";
import { deliveryFor } from "~/narration/cost";
import { fidelity } from "~/providers/chatScripting";
import { speechTarget } from "~/providers/target";
import { endpointVoiceLister, type VoiceLister, type VoiceQuery } from "~/providers/voices";
import { closestDetail, pairByText, retext } from "~/script/pairing";
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

  const library = listEffects(db);
  const effects = effectsPlan(library, file, chapters);
  for (const ch of chapters) {
    ch.segments = ch.segments.map((s) => withEffectIds(s, effects.idOf));
    if (ch.recap != null) ch.recapBefore = chapterRecap(db, bookId, ch.chapterId);
  }
  const effectName = effectNames(library);

  const plan: ScriptImportPlan = {
    title: file.manifest?.title ?? "",
    author: file.manifest?.author ?? "",
    name: upload.name,
    chapters,
    refused,
    ignored: file.ignored,
    cast: castDiff(cast, file.cast, effectName),
    lexicon: lexiconDiff(readLexicon(db, bookId), file.lexicon),
    voices: await voiceRows(db, cast, endpoints, file, ports, limits),
    effects: effects.plan,
  };
  const bookSettings = file.book && bookPlan(book, file.book, endpoints, effectName);
  if (bookSettings?.differ.length) plan.book = bookSettings;
  return plan;
}

// ---------- effects ----------

/** This library's names for effect ids; `"none"` is itself, and a dead id names nothing. */
const effectNames =
  (library: readonly Effect[]) =>
  (id: string | undefined): string | undefined =>
    id === "none" ? id : library.find((e) => e.id === id)?.name;

/**
 * Match the file's effects to the library by name. One the file only names (a lone chapter has no
 * `effects.json`) is the library's when it has one by that name, else missing.
 */
function effectsPlan(
  library: readonly Effect[],
  read: ReadFile,
  chapters: readonly ImportChapter[],
): { plan: ScriptImportPlan["effects"]; idOf: (name: string) => string | undefined } {
  const plan: ScriptImportPlan["effects"] = { known: [], add: [], missing: [] };
  const ids = new Map<string, string>();
  const byName = (name: string) => library.find((e) => e.name === name);
  for (const f of read.effects) {
    if (ids.has(f.name)) continue;
    const have = byName(f.name);
    if (have) {
      plan.known.push({ name: f.name, id: have.id, sameChain: sameJson(have.chain, f.chain) });
      ids.set(f.name, have.id);
    } else {
      plan.add.push(f);
      ids.set(f.name, NEW_EFFECT + f.name);
    }
  }
  const named = new Set([
    ...chapters.flatMap((c) => c.segments.flatMap((s) => s.effects ?? [])),
    ...read.cast.flatMap((c) => [c.effect, c.thoughts]),
    read.book?.thoughts,
  ]);
  for (const name of named) {
    if (!name || name === "none" || ids.has(name)) continue;
    const have = byName(name);
    if (have) {
      plan.known.push({ name, id: have.id, sameChain: true });
      ids.set(name, have.id);
    } else if (!plan.missing.includes(name)) plan.missing.push(name);
  }
  return { plan, idOf: (name) => ids.get(name) };
}

/** A segment's effect names as ids to write; a missing one is dropped. */
function withEffectIds(s: Segment, idOf: (name: string) => string | undefined): Segment {
  if (!s.effects) return s;
  const { effects: names, ...rest } = s;
  const effects = names.flatMap((n) => idOf(n) ?? []);
  return effects.length ? { ...rest, effects } : rest;
}

/** Equal as JSON, whatever order the keys came in. */
function sameJson(a: unknown, b: unknown): boolean {
  const stable = (x: unknown): string =>
    JSON.stringify(x, (_, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => p.localeCompare(q)))
        : v,
    );
  return stable(a) === stable(b);
}

// ---------- the book's settings ----------

const VOICE_SLOTS = ["one", "male", "female", "other"] as const;

/** `book.json` as this install can apply it, and which settings differ from the book's own. */
function bookPlan(
  book: Book,
  file: ScriptFileBook,
  endpoints: readonly Endpoint[],
  effectName: (id: string | undefined) => string | undefined,
): NonNullable<ScriptImportPlan["book"]> {
  const out: ImportBookSettings = {};
  if (file.pacing) out.pacing = file.pacing;
  if (file.prompt) out.prompt = file.prompt;
  if (file.readNotes != null) out.readNotes = file.readNotes;
  if (file.thoughts) out.thoughts = file.thoughts;
  if (file.characterVoice) {
    const enabled = endpoints.filter((e) => e.enabled);
    const voice: CharacterVoice = {
      by: file.characterVoice.by,
      one: null,
      male: null,
      female: null,
      other: null,
    };
    const unmatched: (typeof VOICE_SLOTS)[number][] = [];
    for (const slot of VOICE_SLOTS) {
      const hint = file.characterVoice[slot];
      if (!hint) continue;
      const ref = hereOptions(hint, enabled)[0]?.ref;
      if (ref) voice[slot] = ref;
      else unmatched.push(slot);
    }
    out.characterVoice = voice;
    if (unmatched.length) out.unmatchedVoices = unmatched;
  }
  // an absent readNotes is off; any other absent setting follows the library, so differs
  const mine = {
    pacing: book.pacing,
    prompt: book.prompt,
    readNotes: book.readNotes ?? false,
    thoughts: effectName(book.thoughts),
    characterVoice: book.characterVoice,
  };
  const differ = (["pacing", "prompt", "readNotes", "thoughts", "characterVoice"] as const).filter(
    (k) => out[k] !== undefined && !sameJson(out[k], mine[k]),
  );
  return { file: out, differ };
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
  type Target = { id: number; title: string; body: string; position: number };
  const byHash = new Map<string, Target[]>();
  listChapters(db, bookId).forEach((ch, position) => {
    const body = getChapterBody(db, bookId, ch.id);
    if (body === undefined) return;
    const { hash } = sourceHash(body);
    (byHash.get(hash) ?? byHash.set(hash, []).get(hash)!).push({
      id: ch.id,
      title: ch.title,
      body,
      position,
    });
  });

  const chapters: ImportChapter[] = [];
  const refused: RefusedChapter[] = [];
  const refuse = (
    { file, chapter }: ReadFile["chapters"][number],
    reason: RefusedChapter["reason"],
    detail: string,
  ): void => {
    refused.push({ file, title: chapter.title, words: chapter.words, reason, detail });
  };
  const pair = (
    { file, chapter }: ReadFile["chapters"][number],
    target: Target,
    segments: Segment[],
    text?: Pick<ImportChapter, "wordsDiffer" | "retexted">,
  ): void => {
    chapters.push({
      chapterId: target.id,
      title: target.title,
      fileTitle: chapter.title,
      file,
      segments,
      pairedBy: text ? "text" : "source",
      ...text,
      ...(chapter.recap ? { recap: chapter.recap } : {}),
    });
  };
  const segmentsOf = (lines: ScriptFileLine[]): Segment[] => {
    let annotation = 0;
    const next = (): number => ++annotation;
    return lines.map((l, i) => fromFileLine(l, i + 1, tagsFor(l.speaker), next));
  };

  const loose: { read: ReadFile["chapters"][number]; position: number; segments: Segment[] }[] = [];
  files.forEach((read, position) => {
    const segments = segmentsOf(read.chapter.lines);
    const target = byHash.get(read.chapter.sourceHash)?.shift();
    if (!target) {
      loose.push({ read, position, segments });
      return;
    }
    // The same bar a model's answer clears: an honest correction passes, a rewritten scene does not.
    const check = fidelity(plainText(target.body), segments);
    if (!check.ok) {
      refuse(
        read,
        "fidelity",
        `The lines differ from the chapter by ${check.missing} missing and ${check.added} added words${
          check.examples.length ? ` (missing: ${check.examples.join(", ")})` : ""
        }; at most 2% may.`,
      );
      return;
    }
    pair(read, target, segments);
  });

  // Not the very words: the closest chapter left, if the lines still read it within that bar.
  const free = [...byHash.values()].flat().map((t) => ({ ...t, text: plainText(t.body) }));
  const found = pairByText(
    loose.map((l) => ({ position: l.position, words: l.segments.flatMap((s) => wordsOf(s.text)) })),
    free.map((t) => ({ position: t.position, words: wordsOf(t.text) })),
  );
  loose.forEach(({ read, segments }, i) => {
    const match = found[i];
    if (match.book === undefined) {
      refuse(
        read,
        "unmatched",
        `No chapter of this book has these words${closestDetail(match.closest)}. The EPUB may have changed it, or the script is from another book.`,
      );
      return;
    }
    const target = free[match.book];
    const moved = retext(segments, target.text);
    pair(read, target, moved.segments, {
      wordsDiffer: match.check.missing + match.check.added,
      retexted: moved.retexted,
    });
  });

  chapters.sort((a, b) => a.chapterId - b.chapterId);
  return { chapters, refused };
}

// ---------- the cast and the dictionary ----------

/** Effects by name, as the file writes them. */
function detailsOf(
  c: Pick<SpeakerDetails, "gender" | "description" | "style" | "speed">,
  effect: string | undefined,
  thoughts: string | undefined,
): SpeakerDetails {
  const d: SpeakerDetails = { gender: c.gender, description: c.description, style: c.style };
  if (c.speed != null) d.speed = c.speed;
  if (effect) d.effect = effect;
  if (thoughts) d.thoughts = thoughts;
  return d;
}

const sameDetails = (a: SpeakerDetails, b: SpeakerDetails): boolean =>
  a.gender === b.gender &&
  a.description === b.description &&
  a.style === b.style &&
  a.speed === b.speed &&
  a.effect === b.effect &&
  a.thoughts === b.thoughts;

/** Add what the book lacks, keep what it has, and union the aliases, which only ever adds matches. */
function castDiff(
  cast: Character[],
  file: ScriptFileSpeaker[],
  effectName: (id: string | undefined) => string | undefined,
): ScriptImportPlan["cast"] {
  const out: ScriptImportPlan["cast"] = { add: [], differ: [], aliases: [] };
  for (const speaker of file) {
    const have = cast.find((c) => c.name === speaker.name);
    if (!have) {
      out.add.push(speaker);
      continue;
    }
    const book = detailsOf(have, effectName(have.effect), effectName(have.thoughts));
    const theirs = detailsOf(speaker, speaker.effect, speaker.thoughts);
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

/** The hint's voice on these endpoints: same provider host, voice id and label. */
function hereOptions(hint: VoiceHint, endpoints: readonly Endpoint[]) {
  return endpoints.flatMap((e) =>
    hostOf(e.baseUrl) === hint.provider &&
    e.voices.some((v) => v.id === hint.voiceId && v.label === hint.voiceLabel)
      ? [{ endpointId: e.id, endpointName: e.name, ref: `${e.id}/${hint.voiceId}` }]
      : [],
  );
}

async function matchVoice(
  hint: VoiceHint,
  endpoints: readonly Endpoint[],
  ask: (e: Endpoint, query: VoiceQuery) => Promise<Lookup>,
): Promise<VoiceMatch> {
  const options = hereOptions(hint, endpoints);
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
