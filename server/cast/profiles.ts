// A speaker's profile rewritten from all their facts in reading order, so early chapters
// reprocessed later cannot overwrite later revelations and earlier omissions can be recovered. Several speakers share a request; a long
// list is folded in batches, each carrying the profile on. Disguises are skipped (spoilers).
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
import { profileRows, readFacts, setProfile, staleSpeakers, type ProfileRow } from "~/db/facts";
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
const TOKENS_PER_SPEAKER = 2400;
// ponytail: characters stand in for input tokens; count tokens if batches overrun a model's window
const CHARS_PER_ASK = 24_000;
const FACTS_PER_FOLD = 150;
/** A generous validation ceiling; oversize answers fail rather than losing facts silently. */
const PART_MAX = 2400;

const GENDER: Record<Gender, string> = { m: "male", f: "female", n: "non-binary", "?": "" };

const SYSTEM = [
  "Write concise audiobook cast profiles from the supplied facts and any prior fold. Never invent.",
  '"who": identity, roles, background, relationships, abilities and limitations. "personality": explicit habits or repeated behavior. "voice": lasting vocal qualities, not scene delivery. Use 1–3 sentences per section; "" if unknown; under 2400 characters each.',
  "Keep defining traits, especially speech constraints such as inability to lie. Follow chapter order; distinguish revelations from real changes, and preserve genuine uncertainty. Keep claims with their subject, not their reporter.",
  "Ignore isolated reactions and one-off whispers, even in old facts. Do not infer personality or voice from appearance, morality or mood.",
  `"age": ${AGES.join(", ")} or unknown. "voiceType": pitch (${PITCHES.join(", ")}), texture (${TEXTURES.join(", ")}), up to 3 delivery words (${DELIVERIES.join(", ")}); null where unsupported. Preserve user-selected tags.`,
  "Return the schema's JSON only, one profile per speaker, using the exact supplied names.",
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
  tags: { age?: Age | null; voiceType?: VoiceType | null };
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
        `- ${f.kind}: ${f.text} (chapter ${f.chapterId})${f.evidence && !f.sourceIds?.length ? `\n  Evidence: ${JSON.stringify(f.evidence)}` : ""}`,
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
  const todo: Todo[] = rows.map((c) => {
    const facts = readFacts(db, bookId, c.name);
    const left = facts;
    return {
      c,
      profile: null,
      facts,
      left,
      upTo: Math.max(c.profileUpTo, ...left.map((f) => f.id)),
      tags: {},
    };
  });
  const total = todo.reduce((n, t) => n + t.left.length, 0);
  let done = 0;
  const failed = new Set<string>();
  const rewritten = new Set<string>();
  for (const t of todo.filter((t) => !t.left.length)) {
    if (setProfile(db, bookId, t.c, t.facts, null, t.upTo, { age: null, voiceType: null }))
      rewritten.add(t.c.name);
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
        // Do not silently discard the end of a profile and mark its facts consumed.
        if ([a.who, a.personality, a.voice].some((s) => oneLine(s).length > PART_MAX)) {
          failed.add(t.c.name);
          continue;
        }
        t.profile = {
          who: oneLine(a.who),
          personality: oneLine(a.personality),
          voice: oneLine(a.voice),
        };
        const age = ageOf(a.age);
        const voiceType = voiceTypeOf(a.voiceType);
        t.tags.age = age ?? null;
        t.tags.voiceType = voiceType ?? null;
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
