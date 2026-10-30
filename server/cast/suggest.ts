// The scripting model's voice picks for a few named speakers, from the library's enabled speech
// voices. Only the speaker's own candidates come back, whatever the model said; a simulated profile
// answers with the local match (`suggestVoices`). Stale profiles are rewritten first, so the
// picks read the whole picture. Priced into the book's ledger like a trial.
import * as v from "valibot";

import type { Character, Gender, Voice, VoiceRef, VoiceSuggestions } from "@/types";
import { describe, lineBand, voiceRef } from "@/lib/cast";
import { tokenEstimate } from "@/lib/scripting";
import { suggestVoices, type Bands } from "@/lib/voiceMatch";
import { measuredWords, voiceBands } from "@/lib/voiceProfile";
import { speakerCounts } from "~/cast/ops";
import { rewriteProfiles } from "~/cast/profiles";
import { readCast } from "~/db/cast";
import type { Db } from "~/db/client";
import { readEndpoints, readProfiles } from "~/db/endpoints";
import * as library from "~/db/library";
import { badRequest, fail, notFound } from "~/lib/errors";
import { ProviderError } from "~/providers/http";
import type { SpeechGate } from "~/providers/gate";
import type { ScriptingProvider } from "~/providers/scripting";
import { scriptTarget } from "~/providers/target";
import { assertWithinBudget } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";

export const MAX_SPEAKERS = 30;
const PICKS = 3;
const WHY_WORDS = 12;
const DESCRIPTION_MAX = 1000;
const USERS_SHOWN = 5;

const GENDER: Record<Gender, string> = { m: "male", f: "female", n: "non-binary", "?": "unknown" };

const SYSTEM = `You cast voices for an audiobook. For each speaker, pick ${PICKS} voices from the list, best first.
Rules:
- Only voices of the speaker's gender; any voice when the speaker's gender is unknown.
- Use each voice's ref exactly as listed.
- No two of these speakers share a first pick.
- Prefer voices nobody in the book uses yet.
- Never pick a voice whose "avoid" fits the speaker.
- "why": at most ${WHY_WORDS} words on how the voice fits.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["picks"],
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "voices"],
        properties: {
          speaker: { type: "string" },
          voices: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["voice", "why"],
              properties: { voice: { type: "string" }, why: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

const Answer = v.looseObject({
  picks: v.array(
    v.looseObject({
      speaker: v.string(),
      voices: v.array(v.looseObject({ voice: v.string(), why: v.optional(v.unknown()) })),
    }),
  ),
});

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const words = (s: string, n: number): string => oneLine(s).split(" ").slice(0, n).join(" ");
const fits = (c: Character, voice: Voice): boolean => c.gender === "?" || voice.gender === c.gender;

interface Candidate {
  ref: VoiceRef;
  voice: Voice;
}

/** Only each speaker's candidates, once each, at most three, `why` cut to twelve words. */
export function checkedPicks(
  said: unknown,
  speakers: readonly Character[],
  candidates: ReadonlyMap<string, ReadonlySet<VoiceRef>>,
): VoiceSuggestions {
  const read = v.safeParse(Answer, said);
  const answered = read.success ? read.output.picks : [];
  return {
    picks: speakers.map(({ name }) => {
      const allowed = candidates.get(name)!;
      const seen = new Set<VoiceRef>();
      const voices: VoiceSuggestions["picks"][number]["voices"] = [];
      for (const p of answered.filter((p) => p.speaker.trim() === name))
        for (const { voice, why } of p.voices) {
          const ref = voice.trim();
          if (!allowed.has(ref) || seen.has(ref) || voices.length >= PICKS) continue;
          seen.add(ref);
          voices.push({ voice: ref, why: typeof why === "string" ? words(why, WHY_WORDS) : "" });
        }
      return { speaker: name, voices };
    }),
  };
}

/** Ask the profile's model for voice picks; 404 for an unknown book or profile, 400 for bad names. */
export async function suggestVoicesFor(
  db: Db,
  provider: ScriptingProvider,
  bookId: string,
  request: { profile: string; speakers: string[] },
  signal: AbortSignal,
  gate?: SpeechGate,
): Promise<VoiceSuggestions> {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  const names = [...new Set(request.speakers)];
  if (!names.length) throw badRequest("Name at least one speaker");
  if (names.length > MAX_SPEAKERS)
    throw badRequest(`Ask for at most ${MAX_SPEAKERS} speakers at a time`);
  const known = new Set(readCast(db, bookId).map((c) => c.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length) throw badRequest(`Not in this book’s cast: ${unknown.join(", ")}`);
  const profile = readProfiles(db).find((p) => p.id === request.profile);
  if (!profile) throw notFound(`There is no scripting endpoint “${request.profile}”`);
  if (!provider.ask) throw badRequest(`${provider.name} cannot suggest voices`);
  // the picks go ahead on the profiles as they stand if this fails
  try {
    await rewriteProfiles(
      db,
      provider,
      bookId,
      profile.id,
      names,
      signal,
      undefined,
      undefined,
      gate,
    );
  } catch {
    if (signal.aborted) throw signal.reason;
  }
  const cast = readCast(db, bookId);
  const byName = new Map(cast.map((c) => [c.name, c]));

  const endpoints = readEndpoints(db);
  const bands = voiceBands(endpoints.flatMap((e) => e.voices));
  const pool: Candidate[] = endpoints
    .filter((e) => e.enabled)
    .flatMap((e) => e.voices.map((voice) => ({ ref: voiceRef(e.id, voice.id), voice })));
  if (!pool.length) throw badRequest("No enabled speech endpoint has any voices to suggest");
  const usedBy: Partial<Record<VoiceRef, string[]>> = {};
  for (const c of cast) if (c.voice) (usedBy[c.voice] ??= []).push(c.name);

  const speakers = names.map((n) => byName.get(n)!);
  const candidates = new Map(
    speakers.map((c) => [c.name, new Set(pool.filter((p) => fits(c, p.voice)).map((p) => p.ref))]),
  );
  const listed = pool.filter((p) => speakers.some((c) => candidates.get(c.name)!.has(p.ref)));
  const counts = speakerCounts(db, bookId);

  const speakerLine = (c: Character): string => {
    const vt = c.voiceType;
    const sound = [vt?.pitch, vt?.texture, ...(vt?.delivery ?? [])].filter(Boolean).join(", ");
    return [
      `- ${c.name}`,
      GENDER[c.gender],
      c.age ?? "age unknown",
      sound ? `sounds: ${sound}` : "",
      `${lineBand(counts[c.name]?.lines ?? 0)} lines`,
      oneLine(describe(c)).slice(0, DESCRIPTION_MAX),
    ]
      .filter(Boolean)
      .join(" | ");
  };
  const voiceLine = ({ ref, voice }: Candidate): string => {
    const p = voice.profile;
    const m = p?.measured && measuredWords(p.measured, voice.gender, bands);
    const measured = m
      ? [m.pitch, m.texture, m.intonation].filter(Boolean).join(", ") + (m.rough ? " (rough)" : "")
      : "";
    const users = usedBy[ref] ?? [];
    return [
      `- ${ref}`,
      voice.label,
      GENDER[voice.gender],
      p?.age ?? "",
      measured ? `measured: ${measured}` : "",
      p?.delivery?.length ? `delivery: ${p.delivery.join(", ")}` : "",
      p?.suits?.length ? `suits: ${p.suits.join("; ")}` : "",
      p?.avoid?.length ? `avoid: ${p.avoid.join("; ")}` : "",
      users.length
        ? `used by: ${users.slice(0, USERS_SHOWN).join(", ")}${users.length > USERS_SHOWN ? ` and ${users.length - USERS_SHOWN} more` : ""}`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");
  };
  const user = `Book: ${book.title}\n\nSpeakers:\n${speakers.map(speakerLine).join("\n")}\n\nVoices:\n${listed.map(voiceLine).join("\n")}`;

  const reserve = tokenEstimate(SYSTEM + user, profile).reserve;
  assertWithinBudget(db, bookId, {
    kind: "scripting",
    cost: reserve,
    what: "these voice suggestions",
    requests: [{ endpoint: profile.id, cost: reserve }],
  });
  const money = dispatch(db, {
    kind: "scripting",
    endpoint: profile,
    work: { bookId, chapterUid: null, label: "Voice suggestions" },
    hold: reserve,
  });
  try {
    const said = await provider.ask({
      system: SYSTEM,
      user,
      schema: SCHEMA,
      target: scriptTarget(db, profile),
      signal,
      sent: (report) => void money.sent(report),
      simulated: simulatedPicks(speakers, pool, candidates, bands, usedBy),
    });
    return checkedPicks(said, speakers, candidates);
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    if (e instanceof ProviderError) fail(502, e.message);
    throw e;
  } finally {
    money.release();
  }
}

/** The local match, padded with free voices; a first pick another speaker took moves down. */
function simulatedPicks(
  speakers: readonly Character[],
  pool: readonly Candidate[],
  candidates: ReadonlyMap<string, ReadonlySet<VoiceRef>>,
  bands: Bands,
  usedBy: Partial<Record<VoiceRef, string[]>>,
): v.InferOutput<typeof Answer> {
  const firsts = new Set<VoiceRef>();
  return {
    picks: speakers.map((c) => {
      const mine = pool.filter((p) => candidates.get(c.name)!.has(p.ref));
      const fit = suggestVoices(c, mine, bands, usedBy);
      const why = new Map(fit.map((f) => [f.voice, f.reasons.join(", ")]));
      const free = (ref: VoiceRef) => !usedBy[ref]?.some((n) => n !== c.name);
      const order = [
        ...fit.map((f) => f.voice),
        ...mine.filter((p) => free(p.ref)).map((p) => p.ref),
        ...mine.map((p) => p.ref),
      ];
      const refs = [...new Set(order)];
      const first = refs.findIndex((r) => !firsts.has(r));
      if (first > 0) refs.unshift(...refs.splice(first, 1));
      if (refs[0]) firsts.add(refs[0]);
      return {
        speaker: c.name,
        voices: refs.slice(0, PICKS).map((ref) => ({
          voice: ref,
          why: why.get(ref) || `${free(ref) ? "A free" : "A"} voice of the right gender`,
        })),
      };
    }),
  };
}
