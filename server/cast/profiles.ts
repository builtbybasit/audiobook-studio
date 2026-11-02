// A speaker's profile rewritten from their live facts in reading order, each repeat once: the
// profile so far plus newer facts, or all from scratch after a rebuild mark or when a newer fact
// comes from an earlier chapter. Several speakers share a request; a long list is folded in
// batches. Passing details are marked known; a long list is compacted, repeats marked known.
import * as v from "valibot";

import type {
  Age,
  CastFact,
  CastUsage,
  CharacterProfile,
  Gender,
  Profile,
  RequestRecord,
  VoiceType,
} from "@/types";
import { AGES, COMPACT_AT, DESCRIBED, NARRATOR, castNameFor, isStranger } from "@/lib/cast";
import { tokenEstimate } from "@/lib/scripting";
import { DELIVERIES, PITCHES, TEXTURES } from "@/lib/voiceProfile";
import { mergeCharacters } from "~/cast/ops";
import { chapterSpeakers, readCast } from "~/db/cast";
import type { Db } from "~/db/client";
import { readScript } from "~/db/script";
import { readProfiles } from "~/db/endpoints";
import { getBook, getChapterBody } from "~/db/library";
import { plainText } from "~/epub/markdown";
import { sourceParagraphs } from "@/lib/sourceParagraphs";
import {
  factKey,
  markCompacted,
  profileRows,
  readFacts,
  setProfile,
  staleSpeakers,
  uniqueFacts,
  type ProfileRow,
} from "~/db/facts";
import { badRequest, notFound } from "~/lib/errors";
import { ageOf, voiceTypeOf } from "~/providers/chatScripting";
import { ProviderError } from "~/providers/http";
import { createSpeechGate, type SpeechGate } from "~/providers/gate";
import type { AskInput, ScriptingProvider } from "~/providers/scripting";
import type { SentScript } from "~/providers/sent";
import { scriptTarget } from "~/providers/target";
import { assertWithinBudget } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";

const SPEAKERS_PER_ASK = 20;
/** an answer's share of the output tokens per speaker, so a batch is never cut off */
const TOKENS_PER_SPEAKER = 350;
// ponytail: characters stand in for input tokens; count tokens if batches overrun a model's window
const CHARS_PER_ASK = 24_000;
const FACTS_PER_FOLD = 150;
/** each of the three parts; together about the 1000 characters a profile keeps to */
const PART_MAX = 330;

const GENDER: Record<Gender, string> = { m: "male", f: "female", n: "non-binary", "?": "" };

const SYSTEM = [
  "You keep short profiles of the speakers in a novel, used to cast their audiobook voices.",
  "Each speaker comes with their profile so far (or none) and facts from the book in reading order, labelled F1, F2…. Write each profile again with the facts folded in.",
  '- "who": who they are: role, background, ties to others. "personality": how they think and behave. "voice": how they speak and sound. Each one to three plain sentences; "" when nothing is known.',
  "- Only what the profile and the facts say. Never invent or guess.",
  "- Later facts correct earlier impressions: where they disagree, the later one stands.",
  "- Who they are, not what happens to them: no events, deaths or reveals, and nothing they do in only one scene. Keep defining limits, such as being unable to lie.",
  "- A temporary state in a fact (ill, drugged, afraid, under a spell, acting a part) is not their personality: leave it out.",
  `- "age": ${AGES.join(", ")} or unknown.`,
  `- "voiceType": pitch (${PITCHES.join(", ")}) within their gender, texture (${TEXTURES.join(", ")}), up to 3 delivery words from: ${DELIVERIES.join(", ")}. Null for anything the facts do not suggest.`,
  '- "known": the labels of passing details that say nothing of who they are, how they behave or how they sound. A repeat is not one.',
  "Answer only with the JSON object, one entry per speaker, named as given.",
].join("\n");

const LABELS = { type: "array", items: { type: "string" } };
const nullable = (list: readonly string[]) => ({ type: ["string", "null"], enum: [...list, null] });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["profiles"],
  properties: {
    profiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "who", "personality", "voice", "age", "voiceType", "known"],
        properties: {
          speaker: { type: "string" },
          who: { type: "string" },
          personality: { type: "string" },
          voice: { type: "string" },
          age: { type: "string", enum: [...AGES, "unknown"] },
          voiceType: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["pitch", "texture", "delivery"],
            properties: {
              pitch: nullable(PITCHES),
              texture: nullable(TEXTURES),
              delivery: { type: "array", items: { type: "string", enum: [...DELIVERIES] } },
            },
          },
          known: LABELS,
        },
      },
    },
  },
};

const Said = v.looseObject({
  speaker: v.string(),
  who: v.string(),
  personality: v.string(),
  voice: v.string(),
  age: v.optional(v.nullable(v.string())),
  voiceType: v.optional(v.unknown()),
  known: v.optional(v.unknown()),
});

// the facts a request reads are labelled F1, F2… within their speaker's block
const labelled = (facts: readonly CastFact[]): string[] =>
  facts.map((f, i) => `- F${i + 1} ${f.kind}: ${f.text}`);

/** The fact behind an `F#` label; undefined for anything else. */
function factAt(label: unknown, facts: readonly CastFact[]): CastFact | undefined {
  const n = typeof label === "string" ? /^F(\d+)$/i.exec(label.trim())?.[1] : undefined;
  return n ? facts[Number(n) - 1] : undefined;
}

const listed = (said: unknown): unknown[] => (Array.isArray(said) ? said : []);

/** Each live fact's id under its `factKey`, so a mark on the one shown reaches its copies. */
function copiesOf(facts: readonly CastFact[], names: readonly string[]) {
  const ids = new Map<string, number[]>();
  for (const f of facts) {
    const k = factKey(f, names);
    ids.set(k, [...(ids.get(k) ?? []), f.id]);
  }
  return (f: CastFact): number[] => ids.get(factKey(f, names)) ?? [f.id];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Cut at the last whole sentence that fits. */
function part(s: string): string {
  const t = oneLine(s);
  if (t.length <= PART_MAX) return t;
  const end = t.lastIndexOf(". ", PART_MAX);
  return end > 0 ? t.slice(0, end + 1) : `${t.slice(0, PART_MAX - 1).trimEnd()}…`;
}

interface Todo {
  c: ProfileRow;
  profile: CharacterProfile | null;
  left: CastFact[];
  /** the live facts read, which the save checks against */
  facts: CastFact[];
  upTo: number;
  tags: { age?: Age; voiceType?: VoiceType };
  copies: (f: CastFact) => number[];
  known: number[];
}

/** The speaker as the model reads them: what is known, the profile so far, these facts. */
function block(t: Todo, facts: readonly CastFact[]): string {
  const vt = t.c.edited.includes("voiceType") ? t.c.voiceType : null;
  const sound = [vt?.pitch, vt?.texture, ...(vt?.delivery ?? [])].filter(Boolean).join(", ");
  const known = [
    GENDER[t.c.gender],
    t.c.edited.includes("age") ? t.c.age : "",
    sound ? `user-selected voice: ${sound}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const p = t.profile;
  return [
    `## ${t.c.name}${known ? ` (${known})` : ""}`,
    p
      ? `Profile so far:\nWho: ${p.who}\nPersonality: ${p.personality}\nVoice: ${p.voice}`
      : "Profile so far: none",
    "Facts:",
    ...labelled(facts),
  ].join("\n");
}

/** What a simulated profile answers: the profile so far with the facts' new sentences appended. */
function simulated(batch: readonly { t: Todo; facts: readonly CastFact[] }[]) {
  const join = (was: string | undefined, facts: readonly CastFact[]) =>
    part(
      [
        ...new Set(
          [was ?? "", ...facts.map((f) => f.text)].flatMap((s) => s.split(/(?<=[.!?])\s+/)),
        ),
      ]
        .filter(Boolean)
        .join(" "),
    );
  return {
    profiles: batch.map(({ t, facts }) => ({
      speaker: t.c.name,
      who: join(
        t.profile?.who,
        facts.filter((f) => f.kind !== "personality" && f.kind !== "voice"),
      ),
      personality: join(
        t.profile?.personality,
        facts.filter((f) => f.kind === "personality"),
      ),
      voice: join(
        t.profile?.voice,
        facts.filter((f) => f.kind === "voice"),
      ),
      age: t.c.age ?? "unknown",
      voiceType: null,
      known: [],
    })),
  };
}

/** Requests of at most `most` speakers and about `CHARS_PER_ASK` characters; one long one alone. */
function asks<T extends { text: string }>(items: readonly T[], most: number): T[][] {
  const out: T[][] = [];
  let size = 0;
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.length < most && size + item.text.length <= CHARS_PER_ASK) {
      last.push(item);
      size += item.text.length;
    } else {
      out.push([item]);
      size = item.text.length;
    }
  }
  return out;
}

export const noUsage = (): CastUsage => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInput: 0,
  cost: 0,
});

/** One settled request added to a cast job's usage. */
export function tally(usage: CastUsage, sent: SentScript, charged: RequestRecord | null): void {
  usage.requests += 1;
  usage.inputTokens += sent.usage?.inputTokens ?? 0;
  usage.outputTokens += sent.usage?.outputTokens ?? 0;
  usage.cachedInput += sent.usage?.cachedInput ?? 0;
  usage.cost += charged?.cost ?? 0;
}

export interface Rewritten {
  rewritten: string[];
  /** whose answer was missing or whose request failed; their profile is as it was */
  failed: string[];
}

/** The stale speakers a rewrite would touch, in cast order: never the Narrator. */
export function staleProfiles(db: Db, bookId: string): string[] {
  return staleSpeakers(db, bookId).filter((n) => n !== NARRATOR);
}

/** What every cast request of one run goes through. */
interface Asking {
  db: Db;
  provider: ScriptingProvider;
  bookId: string;
  p: Profile;
  signal: AbortSignal;
  usage?: CastUsage;
  gate: SpeechGate;
  /** speakers per request, so each answer fits the output tokens */
  most: number;
}

function asking(
  db: Db,
  provider: ScriptingProvider,
  bookId: string,
  profileId: string,
  signal: AbortSignal,
  usage: CastUsage | undefined,
  gate: SpeechGate,
): Asking {
  const p: Profile | undefined = readProfiles(db).find((x) => x.id === profileId);
  if (!p) throw notFound(`There is no scripting endpoint “${profileId}”`);
  if (!provider.ask) throw badRequest(`${provider.name} cannot write cast profiles`);
  const most = Math.max(
    1,
    Math.min(SPEAKERS_PER_ASK, Math.floor(p.maxOutputTokens / TOKENS_PER_SPEAKER)),
  );
  return { db, provider, bookId, p, signal, usage, gate, most };
}

/**
 * One request through the endpoint's gate, the budget and the ledger. A budget refusal or a fatal
 * error throws; a provider's failure answers null.
 */
async function request(
  a: Asking,
  what: string,
  ask: Pick<AskInput, "system" | "user" | "schema" | "simulated">,
): Promise<unknown> {
  const { db, bookId, p, signal } = a;
  const leave = await a.gate.acquire(
    p.id,
    () => ({
      concurrency: (readProfiles(db).find((current) => current.id === p.id) ?? p).concurrency,
      enabled: true,
    }),
    { signal },
  );
  try {
    const reserve = tokenEstimate(ask.system + ask.user, p).reserve;
    assertWithinBudget(db, bookId, {
      kind: "scripting",
      cost: reserve,
      what,
      requests: [{ endpoint: p.id, cost: reserve }],
    });
    const money = dispatch(db, {
      kind: "scripting",
      endpoint: p,
      work: { bookId, chapterUid: null, label: "Cast profiles" },
      hold: reserve,
    });
    try {
      return await a.provider.ask!({
        ...ask,
        target: scriptTarget(db, p),
        signal,
        sent: (report) => {
          const charged = money.sent(report);
          if (a.usage) tally(a.usage, report, charged);
        },
      });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      if (!(e instanceof ProviderError)) throw e;
      return null;
    } finally {
      money.release();
    }
  } finally {
    leave();
  }
}

/**
 * Each batch through `work`, the endpoint's concurrency at a time. A fatal error stops new work,
 * but every in-flight request settles before it is thrown.
 */
async function each<T>(a: Asking, batches: readonly T[], work: (b: T) => Promise<void>) {
  let next = 0;
  let stopped = false;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(a.p.concurrency, batches.length) }, async () => {
      while (!stopped && next < batches.length) {
        try {
          a.signal.throwIfAborted();
          await work(batches[next++]);
        } catch (e) {
          stopped = true;
          throw e;
        }
      }
    }),
  );
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  if (rejected) throw rejected.reason;
}

/** An answer's entries by the speaker they name, each read by `schema`. */
function answered<S extends v.GenericSchema<unknown, { speaker: string }>>(
  said: unknown,
  key: string,
  schema: S,
  cast: readonly ProfileRow[],
): Map<string, v.InferOutput<S>> {
  const out = new Map<string, v.InferOutput<S>>();
  for (const item of listed((said as Record<string, unknown> | null)?.[key])) {
    const read = v.safeParse(schema, item);
    if (read.success) out.set(castNameFor(read.output.speaker.trim(), cast), read.output);
  }
  return out;
}

/**
 * Rewrite the stale profiles among `names` with this scripting profile's model; the Narrator never
 * gets one. A speaker is saved only once every batch of theirs is folded, so a failure part way
 * leaves their profile stale, not half-built. Changed evidence or edits discard the reply for a
 * later retry. A budget refusal throws. Each settled request is added to `usage`.
 */
export async function rewriteProfiles(
  db: Db,
  provider: ScriptingProvider,
  bookId: string,
  profileId: string,
  names: readonly string[],
  signal: AbortSignal,
  progress?: (done: number, total: number) => void,
  usage?: CastUsage,
  gate: SpeechGate = createSpeechGate(),
): Promise<Rewritten> {
  const stale = new Set(staleProfiles(db, bookId));
  const wanted = names.filter((n) => stale.has(n));
  if (!wanted.length) return { rewritten: [], failed: [] };
  const a = asking(db, provider, bookId, profileId, signal, usage, gate);

  const rows = profileRows(db, bookId, wanted);
  const rewritten = new Set<string>();
  const todo: Todo[] = rows.flatMap((c) => {
    const all = readFacts(db, bookId, c.name);
    const facts = all.filter((f) => !f.known);
    const names = [c.name, ...c.aliases];
    // the newest fact, live or not, is what the profile is now up to
    const upTo = Math.max(c.profileUpTo, ...all.map((f) => f.id));
    const folded = all.filter((f) => f.id <= c.profileUpTo);
    const said = new Set(folded.map((f) => factKey(f, names)));
    // a repeat of a fact the profile was written from changes nothing
    const fresh = facts.filter((f) => f.id > c.profileUpTo && !said.has(factKey(f, names)));
    // one from an earlier chapter would read as the latest word, so that starts over
    const lastRead = Math.max(0, ...folded.map((f) => f.chapterId));
    const over = !c.profile || c.profileRebuild || fresh.some((f) => f.chapterId < lastRead);
    if (!over && !fresh.length) {
      if (setProfile(db, bookId, c, facts, c.profile, upTo)) rewritten.add(c.name);
      return [];
    }
    const left = uniqueFacts(over ? facts : fresh, names);
    return [
      {
        c,
        profile: over ? null : c.profile,
        facts,
        left,
        upTo,
        tags: {},
        copies: copiesOf(facts, names),
        known: [],
      },
    ];
  });
  const total = todo.reduce((n, t) => n + t.left.length, 0);
  let done = 0;
  const failed = new Set<string>();
  for (const t of todo.filter((t) => !t.left.length)) {
    if (setProfile(db, bookId, t.c, t.facts, null, t.upTo)) rewritten.add(t.c.name);
  }

  /** One request; folds each answered speaker's batch in, and marks the rest failed. */
  const fold = async (batch: { t: Todo; facts: CastFact[]; text: string }[]): Promise<void> => {
    const said = await request(a, "the next profile rewrite", {
      system: SYSTEM,
      schema: SCHEMA,
      user: batch.map((b) => b.text).join("\n\n"),
      simulated: simulated(batch),
    });
    const answers = answered(
      said,
      "profiles",
      Said,
      batch.map(({ t }) => t.c),
    );
    for (const { t, facts } of batch) {
      const ans = answers.get(t.c.name);
      if (!ans) {
        failed.add(t.c.name);
        continue;
      }
      t.profile = {
        who: part(ans.who),
        personality: part(ans.personality),
        voice: part(ans.voice),
      };
      // what the model doesn't know keeps the tag the scripting notes gave, part by part
      const age = ageOf(ans.age);
      const voiceType = voiceTypeOf(ans.voiceType);
      if (age) t.tags.age = age;
      if (voiceType) t.tags.voiceType = { ...t.c.voiceType, ...voiceType };
      for (const label of listed(ans.known)) {
        const f = factAt(label, facts);
        if (f) t.known.push(...t.copies(f));
      }
      t.left = t.left.slice(facts.length);
      if (
        !t.left.length &&
        setProfile(db, bookId, t.c, t.facts, t.profile, t.upTo, t.tags, t.known)
      )
        rewritten.add(t.c.name);
    }
    done += batch.reduce((n, b) => n + b.facts.length, 0);
    progress?.(done, total);
  };

  // round by round, so a speaker's next batch reads the profile the last one wrote;
  // different speakers are independent, a speaker's next fold waits for this round
  for (;;) {
    const round = todo
      .filter((t) => t.left.length && !failed.has(t.c.name))
      .map((t) => {
        let size = block(t, []).length;
        const facts: CastFact[] = [];
        for (const f of t.left.slice(0, FACTS_PER_FOLD)) {
          const length = f.text.length + 100;
          if (facts.length && size + length > CHARS_PER_ASK) break;
          facts.push(f);
          size += length;
        }
        return { t, facts, text: block(t, facts) };
      });
    if (!round.length) break;
    await each(a, asks(round, a.most), fold);
  }
  return {
    rewritten: [...rewritten],
    failed: [...failed],
  };
}

const COMPACT_SYSTEM = [
  "You tidy the facts kept about speakers in a novel, used to cast their audiobook voices.",
  "Each speaker comes with their facts from the book in reading order, labelled F1, F2….",
  '- "repeats": each fact that says again what another says, in other words or not, as {"fact": its label, "of": the label of the one it repeats}. A fact that adds anything the other doesn\'t is not a repeat.',
  '- "known": the labels of passing details that say nothing of who they are, how they behave or how they sound.',
  "Answer only with the JSON object, one entry per speaker, named as given.",
].join("\n");

const COMPACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["speakers"],
  properties: {
    speakers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "repeats", "known"],
        properties: {
          speaker: { type: "string" },
          repeats: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["fact", "of"],
              properties: { fact: { type: "string" }, of: { type: "string" } },
            },
          },
          known: LABELS,
        },
      },
    },
  },
};

const Compacted = v.looseObject({
  speaker: v.string(),
  repeats: v.optional(v.unknown()),
  known: v.optional(v.unknown()),
});

export interface Compacted {
  /** facts marked known */
  marked: number;
  /** whose answer was missing or whose request failed; their facts are as they were */
  failed: string[];
}

/**
 * Mark repeats and passing details among the live facts of those of `names` past the book's
 * `compactAt`, unless it is off, one request per batch of speakers. A list is asked again only once
 * it grew by a quarter of that since. What a repeat says again stays live. Marks land only on facts
 * unchanged since the read; profiles are left as they are.
 */
export async function compactFacts(
  db: Db,
  provider: ScriptingProvider,
  bookId: string,
  profileId: string,
  names: readonly string[],
  signal: AbortSignal,
  usage?: CastUsage,
  gate: SpeechGate = createSpeechGate(),
): Promise<Compacted> {
  const book = getBook(db, bookId);
  if (!book || book.compactOff) return { marked: 0, failed: [] };
  const over = book.compactAt ?? COMPACT_AT.default;
  const grown = Math.ceil(over / 4);
  const todo = profileRows(db, bookId, names).flatMap((c) => {
    const facts = readFacts(db, bookId, c.name, { live: true });
    const names = [c.name, ...c.aliases];
    const shown = uniqueFacts(facts, names);
    if (shown.length <= over || shown.length < c.compactedAt + grown) return [];
    const text = [`## ${c.name}`, "Facts:", ...labelled(shown)].join("\n");
    return [{ c, facts, shown, copies: copiesOf(facts, names), text }];
  });
  if (!todo.length) return { marked: 0, failed: [] };
  const a = asking(db, provider, bookId, profileId, signal, usage, gate);
  let marked = 0;
  const failed: string[] = [];

  await each(a, asks(todo, a.most), async (batch) => {
    const said = await request(a, "the next fact compaction", {
      system: COMPACT_SYSTEM,
      schema: COMPACT_SCHEMA,
      user: batch.map((b) => b.text).join("\n\n"),
      simulated: { speakers: batch.map(({ c }) => ({ speaker: c.name, repeats: [], known: [] })) },
    });
    const answers = answered(
      said,
      "speakers",
      Compacted,
      batch.map(({ c }) => c),
    );
    for (const { c, facts, shown, copies } of batch) {
      const ans = answers.get(c.name);
      if (!ans) {
        failed.push(c.name);
        continue;
      }
      const repeats = listed(ans.repeats).flatMap((r) => {
        const { fact, of } = (r ?? {}) as { fact?: unknown; of?: unknown };
        const f = factAt(fact, shown);
        const o = factAt(of, shown);
        return f && o && f !== o ? [{ f, o }] : [];
      });
      // what another repeats stays live, so nothing points at a hidden fact
      const kept = new Set(repeats.map((r) => r.o));
      const marks = new Map<number, number | undefined>();
      const mark = (f: CastFact, repeatOf?: number) => {
        if (kept.has(f) || marks.has(f.id)) return;
        for (const id of copies(f)) marks.set(id, repeatOf);
      };
      for (const { f, o } of repeats) mark(f, o.id);
      for (const label of listed(ans.known)) {
        const f = factAt(label, shown);
        if (f) mark(f);
      }
      const list = [...marks].map(([id, repeatOf]) => ({ id, repeatOf }));
      const left = shown.filter((f) => !marks.has(f.id)).length;
      if (markCompacted(db, bookId, c.name, facts, list, left)) marked += list.length;
    }
  });
  return { marked, failed };
}

// ---------- strangers ----------

const LINK_SYSTEM = [
  "You decide whether a character a novel has named is the same person as one it showed earlier without a name.",
  "Each is shown by what the text told about them, then the prose around their lines, labelled [#].",
  'Answer {"same": true or false, "sourceIds": the [#] numbers that show it, at least one about each}.',
  "Same when the text says so, or when the unnamed one has specifics of their own that the named one shares, such as a rank, a power, a family or a scar, and nothing contradicts it. What the people around them say or have does not count. A shared look, age or description, such as “a young man”, is not enough.",
].join("\n");

const LINK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["same", "sourceIds"],
  properties: {
    same: { type: "boolean" },
    sourceIds: { type: "array", items: { type: "integer", minimum: 1 } },
  },
};

/** candidates asked about per named speaker, latest first */
const CANDIDATES = 5;
/** lines and fact passages shown per speaker */
const SHOWN = 6;

/**
 * Before first profiles: each named speaker who has none yet is asked about the unnamed strangers
 * ("Young man #1") who fell silent before they spoke, of a matching gender and age. A cited yes
 * merges the stranger into them. Returns how many were merged; names stay out of the job log.
 */
export async function linkStrangers(
  db: Db,
  provider: ScriptingProvider,
  bookId: string,
  profileId: string,
  signal: AbortSignal,
  usage?: CastUsage,
  gate: SpeechGate = createSpeechGate(),
): Promise<number> {
  const cast = readCast(db, bookId);
  const order = chapterSpeakers(db, bookId);
  const chapters = [...order.keys()];
  const span = new Map<string, { first: number; last: number }>();
  [...order.values()].forEach((speakers, i) => {
    for (const s of speakers) span.set(s, { first: span.get(s)?.first ?? i, last: i });
  });
  const strangers = cast.filter((c) => isStranger(c.name) && !c.personaOf && span.has(c.name));
  const fits = (x?: string, y?: string) => !x || !y || x === "?" || y === "?" || x === y;
  const todo = cast.flatMap((c) => {
    const at = span.get(c.name);
    if (
      !at ||
      c.profile ||
      c.name === NARRATOR ||
      c.name === "Unknown" ||
      isStranger(c.name) ||
      DESCRIBED.test(c.name) ||
      c.personaOf ||
      c.masked
    )
      return [];
    const candidates = strangers
      .filter(
        (s) => span.get(s.name)!.last <= at.first && fits(s.gender, c.gender) && fits(s.age, c.age),
      )
      .sort((a, b) => span.get(b.name)!.last - span.get(a.name)!.last)
      .slice(0, CANDIDATES);
    return candidates.length ? [{ c, candidates }] : [];
  });
  if (!todo.length) return 0;

  const passages = (name: string, from: "first" | "last") => {
    const at = span.get(name)!;
    const chapter = chapters[from === "first" ? at.first : at.last];
    const paragraphs = sourceParagraphs(plainText(getChapterBody(db, bookId, chapter) ?? ""));
    // the paragraphs around a line say who they talk with, and about what
    const shown = new Set<number>();
    for (const s of readScript(db, bookId, chapter).filter((x) => x.speaker === name)) {
      const i = paragraphs.findIndex((p) => p.text.includes(s.text.slice(0, 40)));
      if (i < 0) continue;
      for (let j = Math.max(0, i - 2); j <= Math.min(paragraphs.length - 1, i + 1); j++)
        shown.add(j);
      if (shown.size >= SHOWN * 3) break;
    }
    const lines = [...shown].sort((x, y) => x - y).map((j) => paragraphs[j].text);
    const facts = readFacts(db, bookId, name, { live: true }).map((f) => f.text);
    return [...facts.slice(0, SHOWN * 2), ...lines];
  };
  const a = asking(db, provider, bookId, profileId, signal, usage, gate);
  // one stranger per question: a small model picks the wrong one of several look-alikes
  const pairs = todo.flatMap(({ c, candidates }) => candidates.map((s) => ({ c, s })));
  const yes: { c: string; s: string }[] = [];
  await each(a, pairs, async ({ c, s }) => {
    let id = 0;
    const shown = (name: string, from: "first" | "last") =>
      passages(name, from).map((t) => `[${++id}] ${t}`);
    const named = [`## ${c.name} (named)`, ...shown(c.name, "first")];
    const split = id;
    const unnamed = [`## ${s.name} (unnamed)`, ...shown(s.name, "last")];
    const said = await request(a, "linking an unnamed speaker", {
      system: LINK_SYSTEM,
      schema: LINK_SCHEMA,
      user: `${named.join("\n")}\n\n${unnamed.join("\n")}`,
      simulated: { same: false, sourceIds: [] },
    });
    const { same, sourceIds } = (said ?? {}) as { same?: unknown; sourceIds?: unknown };
    const ids = Array.isArray(sourceIds) ? sourceIds.filter(Number.isSafeInteger) : [];
    if (
      same === true &&
      ids.some((n) => n >= 1 && n <= split) &&
      ids.some((n) => n > split && n <= id)
    )
      yes.push({ c: c.name, s: s.name });
  });
  // a stranger two speakers claim, or a speaker claiming two, is left for a person to judge
  const once = (key: "c" | "s", v: string) => yes.filter((y) => y[key] === v).length === 1;
  const merges = yes
    .filter((y) => once("c", y.c) && once("s", y.s))
    .map((y) => ({ from: y.s, into: y.c }));
  if (merges.length) mergeCharacters(db, bookId, merges);
  return merges.length;
}
