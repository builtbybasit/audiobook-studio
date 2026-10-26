// Filling a voice's profile: measured from its kept samples, then written by the scripting model
// from those numbers, a character page and the sample transcripts. Nothing is saved; a step that
// can't run is a note, and only a fill with nothing in it is refused.
import * as v from "valibot";

import type {
  Endpoint,
  MeasuredVoice,
  Profile,
  Voice,
  VoiceProfile,
  VoiceProfileFill,
} from "@/types";
import type { FetchLike } from "@/services/http";
import { AGES } from "@/lib/cast";
import { tokenEstimate } from "@/lib/scripting";
import { DELIVERIES, measuredWords, voiceBands, type MeasuredWords } from "@/lib/voiceProfile";
import type { Db } from "~/db/client";
import { readEndpoint, readEndpoints, readProfiles } from "~/db/endpoints";
import { readKept } from "~/db/voiceSamples";
import { badRequest, notFound } from "~/lib/errors";
import { ProviderError } from "~/providers/http";
import type { ScriptingProvider } from "~/providers/scripting";
import { scriptTarget } from "~/providers/target";
import { budgetProblem } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";
import type { VoiceFiles } from "~/voices/files";
import type { VoiceMeter } from "~/voices/measure";
import { readPage } from "~/voices/wiki";

export interface FillPorts {
  scripting: ScriptingProvider;
  files: VoiceFiles;
  /** absent = this machine has no uv */
  meter?: VoiceMeter;
  fetch?: FetchLike;
}

export interface FillRequest {
  url?: string;
  /** scripting profile id */
  profile?: string;
}

const GENDER_WORD: Record<Voice["gender"], string> = {
  m: "male",
  f: "female",
  n: "non-binary",
  "?": "unknown gender",
};

const LIMITS = { delivery: 3, suits: 5, avoid: 4, summary: 120, style: 80, phrase: 60 };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["age", "delivery", "suits", "avoid", "summary", "previewLine", "narrator", "style"],
  properties: {
    age: { type: ["string", "null"], enum: [...AGES, null] },
    delivery: { type: "array", items: { type: "string", enum: [...DELIVERIES] } },
    suits: { type: "array", items: { type: "string" } },
    avoid: { type: "array", items: { type: "string" } },
    summary: { type: ["string", "null"] },
    previewLine: { type: ["string", "null"] },
    narrator: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["fit", "why"],
      properties: { fit: { type: "boolean" }, why: { type: "string" } },
    },
    style: { type: ["string", "null"] },
  },
};

const Said = v.object({
  age: v.nullish(v.string()),
  delivery: v.nullish(v.array(v.string())),
  suits: v.nullish(v.array(v.string())),
  avoid: v.nullish(v.array(v.string())),
  summary: v.nullish(v.string()),
  previewLine: v.nullish(v.string()),
  narrator: v.nullish(v.object({ fit: v.boolean(), why: v.string() })),
  style: v.nullish(v.string()),
});
type Said = v.InferOutput<typeof Said>;

const SYSTEM = [
  "You describe a voice for an audiobook casting library: how it sounds and which characters it suits.",
  "Lines marked measured come from recordings of this voice; never contradict them.",
  "Use only what you are given. Describe the voice and its manner, never the plot; no spoilers.",
  `delivery: up to ${LIMITS.delivery} words, only from: ${DELIVERIES.join(", ")}.`,
  `age: how old the voice sounds (${AGES.join(", ")}), or null.`,
  `suits: up to ${LIMITS.suits} short phrases naming kinds of character it fits; avoid: up to ${LIMITS.avoid} it does badly.`,
  `summary: one line of at most ${LIMITS.summary} characters.`,
  "previewLine: one line copied word for word from the page or transcripts that shows the voice off, or null.",
  "narrator: whether it could carry a whole book as narrator, and why in a few words.",
  `style: a delivery note of at most ${LIMITS.style} characters for a speaker given this voice, or null.`,
  "Answer only with the JSON object.",
].join("\n");

function measuredLines(m: MeasuredVoice, w: MeasuredWords, gender: string): string[] {
  return [
    `Measured from ${m.voicedSec} s of voiced speech in its samples (measured, do not contradict):`,
    `- pitch: ${w.pitch ? `${w.pitch} for a ${gender} voice` : "no band for this gender"} (median ${m.f0} Hz)`,
    `- texture: ${w.texture ?? "neither husky nor especially clear"} (harmonics-to-noise ${m.hnr} dB)`,
    `- intonation: ${w.intonation} (pitch range ${m.rangeSt} semitones)`,
    ...(w.rough ? ["- little speech was measured, so these are rough"] : []),
  ];
}

const clip = (s: string | null | undefined, max: number): string | undefined => {
  const t = s?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max).trim() : undefined;
};
const phrases = (xs: readonly string[] | null | undefined, n: number): string[] =>
  [...new Set((xs ?? []).map((x) => clip(x, LIMITS.phrase)).filter((x) => x !== undefined))].slice(
    0,
    n,
  );
const words = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The answer in the profile's words: unknown words dropped, lengths cut, `measured` never set. */
function cleaned(said: Said, given: string): VoiceProfile {
  const age = AGES.find((a) => a === said.age?.trim().toLowerCase());
  const delivery = [
    ...new Set(
      (said.delivery ?? [])
        .map((d) => DELIVERIES.find((x) => x === d.trim().toLowerCase()))
        .filter((d) => d !== undefined),
    ),
  ].slice(0, LIMITS.delivery);
  const suits = phrases(said.suits, LIMITS.suits);
  const avoid = phrases(said.avoid, LIMITS.avoid);
  const summary = clip(said.summary, LIMITS.summary);
  // a line the model made up is no preview of this character
  const line = clip(said.previewLine, 500);
  const previewLine = line && words(given).includes(words(line)) ? line : undefined;
  const why = clip(said.narrator?.why, 300);
  const style = clip(said.style, LIMITS.style);
  return {
    ...(age ? { age } : {}),
    ...(delivery.length ? { delivery } : {}),
    ...(suits.length ? { suits } : {}),
    ...(avoid.length ? { avoid } : {}),
    ...(summary ? { summary } : {}),
    ...(previewLine ? { previewLine } : {}),
    ...(said.narrator && why ? { narrator: { fit: said.narrator.fit, why } } : {}),
    ...(style ? { style } : {}),
  };
}

/** What a simulated profile answers: built from the inputs, the same every time. */
function simulatedAnswer(w: MeasuredWords | undefined, page: string, transcripts: string[]): Said {
  const named = DELIVERIES.filter((d) => new RegExp(`\\b${d}\\b`, "i").test(page));
  const heard = w && ({ steady: "calm", even: "warm", lively: "playful" } as const)[w.intonation];
  const delivery = [...new Set([...named, ...(heard ? [heard] : [])])].slice(0, LIMITS.delivery);
  const sound = w ? [w.pitch, w.texture, w.intonation].filter(Boolean).join(", ") : "";
  const quoted = page.match(/^- (.+)$/m)?.[1] ?? transcripts[0] ?? null;
  return {
    age: "young adult",
    delivery,
    suits: ["supporting characters"],
    avoid: [],
    summary: `Simulated: a ${sound || "described"} voice${delivery.length ? `, ${delivery.join(" and ")}` : ""}.`,
    previewLine: quoted,
    narrator: { fit: w?.intonation !== "lively", why: "Simulated from its measures" },
    style: delivery.length ? `Speak ${delivery.join(", ")}` : null,
  };
}

function voiceOf(db: Db, endpointId: string, voiceId: string): { ep: Endpoint; voice: Voice } {
  const ep = readEndpoint(db, endpointId);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${endpointId}`);
  const voice = ep.voices.find((x) => x.id === voiceId);
  if (!voice) throw notFound(`${ep.name} has no such voice`, `voice: ${voiceId}`);
  return { ep, voice };
}

async function measure(
  db: Db,
  ports: FillPorts,
  endpointId: string,
  voiceId: string,
  signal: AbortSignal,
): Promise<{ measured?: MeasuredVoice; note?: string }> {
  const paths = (readKept(db, endpointId, voiceId)?.samples ?? [])
    .map((s) => ports.files.path(endpointId, voiceId, s.file))
    .filter((p) => p !== null);
  if (!paths.length) return { note: "No samples kept, so nothing was measured" };
  if (!ports.meter) return { note: "Not measured: measuring needs uv on this machine" };
  const why = await ports.meter.unavailable();
  if (why) return { note: `Not measured: ${why}` };
  try {
    return { measured: await ports.meter.measure(paths, signal) };
  } catch (e) {
    if (signal.aborted) throw e;
    return { note: `Not measured: ${(e as Error).message}` };
  }
}

/** The model's part, or why it was skipped. Priced into the ledger with no book. */
async function write(
  db: Db,
  ports: FillPorts,
  p: Profile,
  voice: Voice,
  measured: MeasuredVoice | undefined,
  page: string,
  transcripts: string[],
  signal: AbortSignal,
): Promise<{ written?: VoiceProfile; note?: string }> {
  if (!ports.scripting.ask) return { note: `${p.name} cannot write profiles` };
  const gender = GENDER_WORD[voice.gender];
  const w = measured && measuredWords(measured, voice.gender, voiceBands(voiceList(db)));
  const user = [
    `Voice: ${voice.label} (${gender})`,
    ...(measured && w ? measuredLines(measured, w, gender) : []),
    ...(page ? ["", "A page about the character this voice plays:", page] : []),
    ...(transcripts.length
      ? ["", "What is said in its samples:", ...transcripts.map((t) => `- ${t}`)]
      : []),
  ].join("\n");

  const reserve = tokenEstimate(SYSTEM + user, p).reserve;
  const problem = budgetProblem(db, null, {
    kind: "scripting",
    cost: reserve,
    what: "this profile",
    requests: [{ endpoint: p.id, cost: reserve }],
  });
  if (problem) return { note: problem };
  const money = dispatch(db, {
    kind: "scripting",
    endpoint: p,
    work: { bookId: null, chapterUid: null, label: `Voice profile · ${voice.label}` },
    hold: reserve,
  });
  let answer: unknown;
  try {
    answer = await ports.scripting.ask({
      system: SYSTEM,
      user,
      schema: SCHEMA,
      target: scriptTarget(db, p),
      signal,
      sent: (report) => void money.sent(report),
      simulated: simulatedAnswer(w, page, transcripts),
    });
  } catch (e) {
    if (signal.aborted || !(e instanceof ProviderError)) throw e;
    return { note: `Not written: ${e.message}` };
  } finally {
    money.release();
  }
  const said = v.safeParse(Said, answer);
  if (!said.success) return { note: "The model's answer did not fit, so nothing was written" };
  return { written: cleaned(said.output, `${page}\n${transcripts.join("\n")}`) };
}

const voiceList = (db: Db): Voice[] => readEndpoints(db).flatMap((e) => e.voices);

export async function fillProfile(
  db: Db,
  ports: FillPorts,
  endpointId: string,
  voiceId: string,
  request: FillRequest,
  signal: AbortSignal,
): Promise<VoiceProfileFill> {
  const { voice } = voiceOf(db, endpointId, voiceId);
  const notes: string[] = [];
  const note = (n: string | undefined): void => void (n && notes.push(n));

  const { measured, note: measuring } = await measure(db, ports, endpointId, voiceId, signal);
  note(measuring);

  const url = request.url?.trim();
  const p = request.profile ? readProfiles(db).find((x) => x.id === request.profile) : undefined;
  if (request.profile && !p) note(`There is no scripting endpoint “${request.profile}”`);
  if (url && !p) note("Pick a scripting endpoint to fill from the page");

  let written: VoiceProfile | undefined;
  let source: VoiceProfile["source"];
  if (p) {
    let page = "";
    if (url)
      try {
        page = await readPage(url, signal, ports.fetch);
        source = { url, at: Date.now() };
      } catch (e) {
        if (signal.aborted) throw e;
        note(`Page not read: ${(e as Error).message}`);
      }
    const transcripts = (readKept(db, endpointId, voiceId)?.samples ?? [])
      .map((s) => s.transcript?.trim() ?? "")
      .filter(Boolean);
    if (!measured && !page && !transcripts.length)
      note("Nothing for the model to write from: keep samples or give a page");
    else {
      const out = await write(db, ports, p, voice, measured, page, transcripts, signal);
      written = out.written;
      note(out.note);
    }
  }

  const profile: VoiceProfile = {
    ...(measured ? { measured } : {}),
    ...written,
    ...(written && source ? { source } : {}),
  };
  if (!Object.keys(profile).length) throw badRequest(notes.join(". "));
  return { profile, notes };
}
