// A speaker's profile rewritten from their facts in reading order, each repeat once: the profile
// so far plus newer facts, or every fact from scratch after a rebuild mark or when a newer fact
// comes from an earlier chapter. Several speakers share a request; a long list is folded in
// batches, each carrying the profile on. Disguises are skipped (spoilers).
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
import { AGES, NARRATOR, castNameFor } from "@/lib/cast";
import { tokenEstimate } from "@/lib/scripting";
import { DELIVERIES, PITCHES, TEXTURES } from "@/lib/voiceProfile";
import type { Db } from "~/db/client";
import { readProfiles } from "~/db/endpoints";
import {
  factKey,
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
import type { ScriptingProvider } from "~/providers/scripting";
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
  "Each speaker comes with their profile so far (or none) and facts from the book in reading order. Write each profile again with the facts folded in.",
  '- "who": who they are: role, background, ties to others. "personality": how they think and behave. "voice": how they speak and sound. Each one to three plain sentences; "" when nothing is known.',
  "- Only what the profile and the facts say. Never invent or guess.",
  "- Later facts correct earlier impressions: where they disagree, the later one stands.",
  "- Who they are, not what happens to them: no events, deaths or reveals, and nothing they do in only one scene. Keep defining limits, such as being unable to lie.",
  `- "age": ${AGES.join(", ")} or unknown.`,
  `- "voiceType": pitch (${PITCHES.join(", ")}) within their gender, texture (${TEXTURES.join(", ")}), up to 3 delivery words from: ${DELIVERIES.join(", ")}. Null for anything the facts do not suggest.`,
  "Answer only with the JSON object, one entry per speaker, named as given.",
].join("\n");

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
        required: ["speaker", "who", "personality", "voice", "age", "voiceType"],
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
});

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
  facts: CastFact[];
  upTo: number;
  tags: { age?: Age; voiceType?: VoiceType };
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
    ...facts.map(
      (f) =>
        `- ${f.kind}: ${f.text}${f.evidence && !f.sourceIds?.length ? `\n  Evidence: ${JSON.stringify(f.evidence)}` : ""}`,
    ),
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

/** The stale speakers a rewrite would touch, in cast order: never the Narrator or a disguise. */
export function staleProfiles(db: Db, bookId: string): string[] {
  const stale = staleSpeakers(db, bookId).filter((n) => n !== NARRATOR);
  if (!stale.length) return [];
  const disguised = new Set(
    profileRows(db, bookId, stale)
      .filter((c) => c.personaOf || c.masked)
      .map((c) => c.name),
  );
  return stale.filter((n) => !disguised.has(n));
}

/**
 * Rewrite the stale profiles among `names` with this scripting profile's model. Narrator and
 * disguises never get one. A speaker is saved only once every batch of theirs is folded, so a
 * failure part way leaves their profile stale, not half-built. Changed evidence or edits discard
 * the reply for a later retry. A budget refusal throws. Each
 * settled request is added to `usage`.
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
  const p: Profile | undefined = readProfiles(db).find((x) => x.id === profileId);
  if (!p) throw notFound(`There is no scripting endpoint “${profileId}”`);
  if (!provider.ask) throw badRequest(`${provider.name} cannot write cast profiles`);

  const rows = profileRows(db, bookId, wanted);
  const rewritten = new Set<string>();
  const todo: Todo[] = rows.flatMap((c) => {
    const facts = readFacts(db, bookId, c.name);
    const names = [c.name, ...c.aliases];
    const upTo = Math.max(c.profileUpTo, ...facts.map((f) => f.id));
    const folded = facts.filter((f) => f.id <= c.profileUpTo);
    const known = new Set(folded.map((f) => factKey(f, names)));
    // a repeat of a fact the profile was written from changes nothing
    const fresh = facts.filter((f) => f.id > c.profileUpTo && !known.has(factKey(f, names)));
    // one from an earlier chapter would read as the latest word, so that starts over
    const lastRead = Math.max(0, ...folded.map((f) => f.chapterId));
    const over = !c.profile || c.profileRebuild || fresh.some((f) => f.chapterId < lastRead);
    if (!over && !fresh.length) {
      if (setProfile(db, bookId, c, facts, c.profile, upTo)) rewritten.add(c.name);
      return [];
    }
    const left = uniqueFacts(over ? facts : fresh, names);
    return [{ c, profile: over ? null : c.profile, facts, left, upTo, tags: {} }];
  });
  const total = todo.reduce((n, t) => n + t.left.length, 0);
  let done = 0;
  const failed = new Set<string>();
  for (const t of todo.filter((t) => !t.left.length)) {
    if (setProfile(db, bookId, t.c, t.facts, null, t.upTo)) rewritten.add(t.c.name);
  }
  const most = Math.max(
    1,
    Math.min(SPEAKERS_PER_ASK, Math.floor(p.maxOutputTokens / TOKENS_PER_SPEAKER)),
  );

  /** One request; folds each answered speaker's batch in, and marks the rest failed. */
  const ask = async (batch: { t: Todo; facts: CastFact[]; text: string }[]): Promise<void> => {
    const leave = await gate.acquire(
      p.id,
      () => ({
        concurrency: (readProfiles(db).find((current) => current.id === p.id) ?? p).concurrency,
        enabled: true,
      }),
      { signal },
    );
    try {
      const user = batch.map((b) => b.text).join("\n\n");
      const reserve = tokenEstimate(SYSTEM + user, p).reserve;
      assertWithinBudget(db, bookId, {
        kind: "scripting",
        cost: reserve,
        what: "the next profile rewrite",
        requests: [{ endpoint: p.id, cost: reserve }],
      });
      const money = dispatch(db, {
        kind: "scripting",
        endpoint: p,
        work: { bookId, chapterUid: null, label: "Cast profiles" },
        hold: reserve,
      });
      let said: unknown;
      try {
        said = await provider.ask!({
          system: SYSTEM,
          user,
          schema: SCHEMA,
          target: scriptTarget(db, p),
          signal,
          sent: (report) => {
            const charged = money.sent(report);
            if (usage) tally(usage, report, charged);
          },
          simulated: simulated(batch),
        });
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        if (!(e instanceof ProviderError)) throw e;
        said = null;
      } finally {
        money.release();
      }
      const list = (said as { profiles?: unknown } | null)?.profiles;
      const answers = new Map<string, v.InferOutput<typeof Said>>();
      for (const item of Array.isArray(list) ? list : []) {
        const read = v.safeParse(Said, item);
        if (read.success)
          answers.set(
            castNameFor(
              read.output.speaker.trim(),
              batch.map(({ t }) => t.c),
            ),
            read.output,
          );
      }
      for (const { t, facts } of batch) {
        const a = answers.get(t.c.name);
        if (!a) {
          failed.add(t.c.name);
          continue;
        }
        t.profile = { who: part(a.who), personality: part(a.personality), voice: part(a.voice) };
        // what the model doesn't know keeps the tag the scripting notes gave, part by part
        const age = ageOf(a.age);
        const voiceType = voiceTypeOf(a.voiceType);
        if (age) t.tags.age = age;
        if (voiceType) t.tags.voiceType = { ...t.c.voiceType, ...voiceType };
        t.left = t.left.slice(facts.length);
        if (!t.left.length && setProfile(db, bookId, t.c, t.facts, t.profile, t.upTo, t.tags))
          rewritten.add(t.c.name);
      }
      done += batch.reduce((n, b) => n + b.facts.length, 0);
      progress?.(done, total);
    } finally {
      leave();
    }
  };

  // round by round, so a speaker's next batch reads the profile the last one wrote
  for (;;) {
    const round = todo
      .filter((t) => t.left.length && !failed.has(t.c.name))
      .map((t) => {
        let size = block(t, []).length;
        const facts: CastFact[] = [];
        for (const f of t.left.slice(0, FACTS_PER_FOLD)) {
          const length =
            f.text.length + (f.sourceIds?.length ? 0 : (f.evidence?.length ?? 0)) + 100;
          if (facts.length && size + length > CHARS_PER_ASK) break;
          facts.push(f);
          size += length;
        }
        return { t, facts, text: block(t, facts) };
      });
    if (!round.length) break;
    // Different speakers are independent; a speaker's next fold waits for this round.
    // Stop taking work on a fatal error, but settle every in-flight request before returning.
    const batches = asks(round, most);
    let next = 0;
    let stopped = false;
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(p.concurrency, batches.length) }, async () => {
        while (!stopped && next < batches.length) {
          try {
            signal.throwIfAborted();
            await ask(batches[next++]);
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
  return {
    rewritten: [...rewritten],
    failed: [...failed],
  };
}
