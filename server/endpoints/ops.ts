// The endpoints, as the Endpoints page saves them: the whole configuration at once.
//
// Speech endpoints, scripting profiles and the credential registry are one screen's worth of
// settings, edited in place and saved together, so a save is a replacement rather than a patch —
// the page sends what it holds and the server keeps exactly that. What is checked here is what the
// tables cannot hold or would hold wrongly: two endpoints of one kind under one id (a speech
// endpoint and a scripting profile may share one — the seeded world's `openai` is both), two
// voices or tags under one id on one endpoint, and an endpoint pointing at a credential that is
// not in the registry being saved with it. The scripting prompts saved with them — the library's
// default, and each profile's say over it — are held to the rules the editor shows (`@/lib/prompt`),
// and the scripting settings may only choose a profile saved with them.
import type {
  Credential,
  Endpoint,
  EndpointBatches,
  EndpointKind,
  EndpointProbe,
  Transcriber,
  VoiceListPage,
} from "@/types";
import { profilePromptProblems, promptProblems, resolvePrompt } from "@/lib/prompt";
import { isSimulated } from "@/lib/providers";
import { billingOf } from "@/lib/endpoints";
import { worstCaseOf } from "@/lib/narrationCost";
import { AUDIO_CHARS_PER_SECOND, estimateSpeech, measureSpeech, readPricing } from "@/lib/pricing";
import { encodingOf, VOICE_SAMPLE } from "@/lib/endpointShapes";
import type { Db, Tx } from "~/db/client";
import {
  readEndpoint,
  readProfiles,
  readEndpointConfig,
  readTranscriber,
  replaceEndpoints,
  type EndpointConfig,
} from "~/db/endpoints";
import { readLibraryPrompt } from "~/db/settings";
import { reconcileClones } from "~/db/voiceSamples";
import { inBackground, warnIfFails } from "~/lib/background";
import { AppError, badRequest, notFound } from "~/lib/errors";
import { refusePrompt } from "~/lib/schemas";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { ProviderError } from "~/providers/http";
import { SAMPLE_HEAD_BYTES, SAMPLE_MIME, sniffSample, type SampleFormat } from "~/providers/clone";
import { scriptTarget, speechTarget, transcriberTarget, type Providers } from "~/providers/target";
import { endpointTranscriber, type Transcript } from "~/providers/transcription";
import { endpointVoiceLister, type VoiceQuery } from "~/providers/voices";
import { assertWithinBudget } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";
import { parseBuffer } from "music-metadata";
import type { VoiceFiles } from "~/voices/files";
import { removeDropped } from "~/voices/ops";

/** What the page reads: the configuration as saved, or none on a server nobody has saved to. */
export function endpointSettings(db: Db | Tx): EndpointConfig {
  return readEndpointConfig(db);
}

/** The first id in `ids` that has been seen before, if any. */
function repeated(ids: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function check(config: EndpointConfig): void {
  const transcribers = config.transcribers ?? [];
  const all = [...config.endpoints, ...config.profiles, ...transcribers];
  for (const [kind, list] of [
    ["speech endpoints", config.endpoints],
    ["scripting profiles", config.profiles],
    ["transcription endpoints", transcribers],
  ] as const) {
    const twice = repeated(list.map((e) => e.id));
    if (twice) throw badRequest(`Two ${kind} are called “${twice}”`);
  }

  const credential = repeated(config.credentials.map((c) => c.id));
  if (credential) throw badRequest(`Two credentials are called “${credential}”`);
  const known = new Set(config.credentials.map((c: Credential) => c.id));
  for (const e of all)
    if (e.credentialId != null && !known.has(e.credentialId))
      throw badRequest(
        `“${e.name || e.id}” uses a credential that is not in the list`,
        `credentialId: ${e.credentialId}`,
      );

  for (const e of config.endpoints) {
    const owned: [string, string[]][] = [
      ["voice", e.voices.map((v) => v.id)],
      ["expression", (e.expressions?.tags ?? []).map((t) => t.id)],
      ["rate window", (e.pricing?.windows ?? []).map((w) => w.id)],
      ["promotion", (e.pricing?.promotions ?? []).map((p) => p.id)],
    ];
    for (const [what, ids] of owned) {
      const id = repeated(ids);
      if (id) throw badRequest(`“${e.name || e.id}” has two of one ${what}`, `${what}: ${id}`);
    }
  }
  for (const p of [...config.profiles, ...transcribers]) {
    const owned: [string, string[]][] = [
      ["rate window", (p.pricing?.windows ?? []).map((w) => w.id)],
      ["promotion", (p.pricing?.promotions ?? []).map((x) => x.id)],
    ];
    for (const [what, ids] of owned) {
      const id = repeated(ids);
      if (id) throw badRequest(`“${p.name || p.id}” has two of one ${what}`, `${what}: ${id}`);
    }
    if ("prompt" in p && p.prompt)
      refusePrompt(`“${p.name || p.id}”'s prompt`, profilePromptProblems(p.prompt));
  }
  if (config.prompt) refusePrompt("The library's prompt", promptProblems(config.prompt));
  // the profile runs go to is one of the profiles saved with it, or none
  const chosen = config.script?.profile;
  if (chosen != null && !config.profiles.some((p) => p.id === chosen))
    throw badRequest(
      "The scripting settings choose a profile that is not in the list",
      `profile: ${chosen}`,
    );
}

/**
 * Keep this configuration in place of the stored one, all or nothing.
 *
 * Nothing already rendered is touched. A clip records the endpoint, the tags and the rate it was
 * rendered with, and the Narration page's drift rule compares those against the endpoint as it now
 * stands — so a tag redefined or a rate changed reads as drift on exactly the clips it reaches,
 * without this having to find them.
 */
export function saveEndpoints(
  db: Db | Tx,
  config: EndpointConfig,
  voiceFiles: VoiceFiles,
): EndpointConfig {
  check(config);
  // The kept recordings are lined up with the voices in the same transaction: a voice removed on
  // the page takes the recordings it was made from with it once the removal has outlived its Undo,
  // and never the other way round.
  const gone = db.transaction((tx) => {
    replaceEndpoints(tx, config);
    return reconcileClones(tx, config, Date.now());
  });
  removeDropped(voiceFiles, gone);
  // what the demo buttons played for an endpoint that is gone goes with it
  inBackground(
    voiceFiles.heard.keepOnly(config.endpoints.map((e) => e.id)),
    "voice samples of removed endpoints left on disk",
  );
  return endpointSettings(db);
}

/**
 * Ask a saved endpoint one small question with its saved key, through the provider its runs go
 * through — so it is the request a real run would make, and a simulated endpoint says it answered
 * without one rather than pretending a request went out. What is tested is what is saved: an edit
 * on the page is not the endpoint until it is.
 */
export async function testEndpoint(
  db: Db,
  providers: Providers,
  kind: EndpointKind,
  id: string,
  signal: AbortSignal,
): Promise<EndpointProbe> {
  if (kind === "tts") {
    const ep = readEndpoint(db, id);
    if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
    const probe = providers.speech.probe;
    if (!probe) return untestable(providers.speech.name);
    return probe.call(providers.speech, speechTarget(db, ep), signal);
  }
  if (kind === "transcription") {
    const t = readTranscriber(db, id);
    if (!t) throw notFound("There is no saved transcription endpoint by that id", `id: ${id}`);
    const started = Date.now();
    try {
      const sample = await Bun.file(TEST_SAMPLE).bytes();
      const { text } = await hear(db, providers, t, sample, "wav", "Connection test", signal);
      const ms = Date.now() - started;
      return text
        ? { ok: true, message: `Heard “${text}” in ${ms} ms`, ms }
        : { ok: false, message: `Answered in ${ms} ms but heard nothing`, ms };
    } catch (e) {
      if (e instanceof ProviderError) return { ok: false, message: e.message, ms: 0 };
      throw e;
    }
  }
  const profile = readProfiles(db).find((p) => p.id === id);
  if (!profile) throw notFound("There is no saved scripting profile by that id", `id: ${id}`);
  const probe = providers.scripting.probe;
  if (!probe) return untestable(providers.scripting.name);
  // the prompt this profile's runs would be sent, over a book with none of its own
  const { system, user } = resolvePrompt({
    library: readLibraryPrompt(db),
    profile: profile.prompt,
  });
  return probe.call(providers.scripting, scriptTarget(db, profile), signal, {
    template: { system, user },
    notes: profile.prompt?.notes ?? "",
  });
}

const untestable = (name: string): EndpointProbe => ({
  ok: false,
  message: `${name} has no connection test`,
  ms: 0,
});

/**
 * A provider's failure, as the answer to the page that asked on its behalf. Whose it is to fix
 * decides the status:
 *
 * - refused before any request (status 0, not retryable) — no key, a provider that cannot do this —
 *   is the request's, a `400`;
 * - a 4xx the provider answered, other than a timeout (408) or a rate limit (429), is the request's
 *   too — a key Fish does not know, a recording it cannot read, a title it will not take — and the
 *   provider's own words are passed on as a `400`, since trying again unchanged will not help;
 * - anything else — a 429, a 5xx, no answer at all, an answer that made no sense — is the
 *   provider's, a `502`.
 *
 * The message is the `ProviderError`'s, which names the provider and what it said and never
 * carries the key.
 */
export function providerFailure(e: ProviderError): AppError {
  const refusedHere = e.status === 0 && !e.retryable;
  const refusedThere = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
  return new AppError(refusedHere || refusedThere ? 400 : 502, e.message);
}

/**
 * The voices a saved speech endpoint offers, asked with its saved key.
 *
 * Always of the endpoint itself — only a test hands over a lister that answers from memory: a list
 * of voices costs nothing and changes nothing, and a simulated endpoint answers with the few voices
 * it names. The answer is only shown; putting a voice on the endpoint is the page's own
 * whole-configuration save.
 */
export async function listVoices(
  db: Db,
  providers: Providers,
  id: string,
  query: VoiceQuery,
  signal: AbortSignal,
): Promise<VoiceListPage> {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const lister = providers.voices ?? endpointVoiceLister();
  try {
    return await lister.list(speechTarget(db, ep), query, signal);
  } catch (e) {
    throw e instanceof ProviderError ? providerFailure(e) : e;
  }
}

/**
 * What a saved speech endpoint's server says about batches, asked with its saved key: the limits a
 * run would send it batches under, or null when it takes none — a provider with no batch route, a
 * simulated endpoint, a server that does not answer the capabilities route for this model. Asked
 * whether or not the endpoint's batches are switched on, so the page can say what turning them on
 * would do. Always asked afresh, so a limit raised on the server shows at once, and the next run
 * goes by what it said.
 */
export async function batchLimits(
  db: Db,
  providers: Providers,
  id: string,
  signal: AbortSignal,
): Promise<EndpointBatches> {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const ask = providers.speech.batchLimits;
  if (!ask) return { limits: null };
  try {
    return { limits: await ask.call(providers.speech, speechTarget(db, ep), signal, true) };
  } catch (e) {
    throw e instanceof ProviderError ? providerFailure(e) : e;
  }
}

/** What a demo button plays: the audio, and where it came from. */
export interface VoiceSampleAudio {
  bytes: Uint8Array;
  mime: string;
  /** seconds, when known — a provider's recording is played for as long as its file says */
  duration: number | null;
  /** the provider's own recording of the voice, or the endpoint saying `VOICE_SAMPLE` */
  source: "recording" | "rendered";
  /** served from what was kept, so nothing was asked of the provider this time */
  kept: boolean;
}

/** What a provider's own recording of a voice is kept under: it is the same whatever the endpoint. */
const RECORDING = "recording";

/**
 * What a rendered sample is kept under: everything that changes how it sounds. An endpoint moved to
 * another model, format or rate has a sample made again, not the old one played.
 */
const renderedAs = (ep: Endpoint): string =>
  JSON.stringify([
    "rendered",
    ep.baseUrl,
    ep.model,
    encodingOf(ep),
    ep.sampleRate ?? null,
    VOICE_SAMPLE,
  ]);

/**
 * One voice of a saved speech endpoint, heard: what the demo buttons and the Voices tab play.
 *
 * What was played for the voice before is played again from disk, free (`VoiceFiles.heard`).
 * Otherwise the provider's own recording of the voice, where it keeps one — Fish does, for most of
 * its voices — is fetched and kept; that costs nothing either. Failing both, the endpoint says the
 * sample sentence (`VOICE_SAMPLE`) with its saved key, and that is kept: a real request, the one
 * that is billed, once.
 *
 * A rendered sample is always of the endpoint itself, like `listVoices`, whatever a test runs its
 * narration through, and a simulated endpoint's is its tone — never kept, as it costs nothing to
 * make again. It is asked for the way a line of narration is — the endpoint's format and sample
 * rate — so what is heard is what a chapter would sound like, and the request is priced into the
 * ledger against the endpoint with no book. One attempt, like a connection test: a failure says so
 * at once.
 */
export async function sampleVoice(
  db: Db,
  providers: Providers,
  files: VoiceFiles,
  id: string,
  voiceId: string,
  signal: AbortSignal,
): Promise<VoiceSampleAudio> {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const simulated = isSimulated(ep.baseUrl);
  const rendered = renderedAs(ep);
  const heard = (
    bytes: Uint8Array,
    format: SampleFormat,
    made: string,
    kept: boolean,
    duration: number | null = null,
  ): VoiceSampleAudio => ({
    bytes,
    mime: SAMPLE_MIME[format],
    duration,
    source: made === RECORDING ? "recording" : "rendered",
    kept,
  });

  if (!simulated) {
    const kept = await files.heard.read(ep.id, voiceId, [RECORDING, rendered]);
    if (kept) return heard(kept.bytes, kept.format, kept.made, true);
    const recording = await ownRecording(db, providers, ep, voiceId, signal);
    if (recording) {
      await files.heard.keep(ep.id, voiceId, RECORDING, recording.bytes, recording.format);
      return heard(recording.bytes, recording.format, RECORDING, false);
    }
  }

  const voice = ep.voices.find((v) => v.id === voiceId);
  const speaker = voice?.label || voiceId;
  const provider = providers.samples ?? endpointSpeechProvider();
  // billed to the endpoint like a line of narration, so held to its daily limit like one
  const cost = sampleWorstCase(ep);
  assertWithinBudget(db, null, {
    kind: "narration",
    cost,
    requests: [{ endpoint: ep.id, cost }],
    request: "this voice sample",
  });
  // held to the endpoint's daily limit while it is out, and priced into the ledger as it settles
  const money = dispatch(db, {
    kind: "tts",
    endpoint: ep,
    work: {
      bookId: null,
      chapterUid: null,
      label: `Voice sample · ${speaker}`,
      voiceRef: `${ep.id}/${voiceId}`,
    },
    hold: cost,
  });
  let clip;
  try {
    clip = await provider.speak({
      text: VOICE_SAMPLE,
      speaker,
      type: "narration",
      direction: "",
      instructions: "",
      voiceRef: `${ep.id}/${voiceId}`,
      sampleRate: ep.sampleRate ?? null,
      encoding: encodingOf(ep),
      target: { ...speechTarget(db, ep), maxRetries: 0 },
      signal,
      sent: money.sent,
    });
  } catch (e) {
    throw e instanceof ProviderError ? providerFailure(e) : e;
  } finally {
    money.release();
  }
  // Paid for, so kept — before answering, so the next press finds it. A sample that could not be
  // kept still plays, and the log says so.
  if (!simulated)
    await warnIfFails(
      files.heard.keep(ep.id, voiceId, rendered, clip.bytes, clip.format),
      "voice sample not kept",
      { id, voiceId },
    );
  return heard(clip.bytes, clip.format, rendered, false, clip.duration);
}

/** What saying the sample sentence holds at worst, measured as a line of narration is. */
function sampleWorstCase(ep: Endpoint): number {
  const billing = billingOf(ep);
  const units = measureSpeech(
    { text: VOICE_SAMPLE, audioSeconds: VOICE_SAMPLE.length / AUDIO_CHARS_PER_SECOND },
    billing,
  );
  return worstCaseOf(estimateSpeech(billing, readPricing(ep), units, Date.now()));
}

/**
 * The provider's own recording of the voice, when it keeps one. A failure to find one — no key, the
 * provider down — is not the sample's failure: the endpoint is asked to say the sentence instead,
 * and that request says what is wrong if anything is.
 */
async function ownRecording(
  db: Db,
  providers: Providers,
  ep: Endpoint,
  voiceId: string,
  signal: AbortSignal,
) {
  const lister = providers.voices ?? endpointVoiceLister();
  if (!lister.recording) return null;
  try {
    return await lister.recording(speechTarget(db, ep), voiceId, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}

// ---------- hearing a recording ----------

/** What a recording sent to be transcribed is said to be, when its bytes say nothing clearer. */
const NAMES: Record<SampleFormat, string> = {
  wav: "sample.wav",
  mp3: "sample.mp3",
  m4a: "sample.m4a",
  opus: "sample.ogg",
  flac: "sample.flac",
};

/**
 * What is said in a clone sample, heard by a transcription endpoint — the one named, or the first
 * switched on. Priced into the ledger against it with no book, held to its daily limit, and tried
 * once: a click that fails says so at once.
 */
export async function transcribeSample(
  db: Db,
  providers: Providers,
  file: File,
  id: string | undefined,
  signal: AbortSignal,
): Promise<{ text: string }> {
  const t = readTranscriber(db, id);
  if (!t)
    throw id
      ? notFound("There is no saved transcription endpoint by that id", `id: ${id}`)
      : badRequest("No transcription endpoint is switched on. Add one on the Endpoints page.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffSample(bytes.subarray(0, SAMPLE_HEAD_BYTES));
  if (!format) throw badRequest("That file is not audio this app can read");
  try {
    return {
      text: (await hear(db, providers, t, bytes, format, "Sample transcript", signal)).text,
    };
  } catch (e) {
    throw e instanceof ProviderError ? providerFailure(e) : e;
  }
}

/**
 * The recording a transcription endpoint's Test sends: Fish Audio saying “The quick brown fox jumps
 * over the lazy dog.”, as 16 kHz mono WAV, 3.4 s (`PROBE.transcription` on the page).
 */
const TEST_SAMPLE = new URL("./test-sample.wav", import.meta.url);

/**
 * One recording heard by `t`, with no book: priced into the ledger under `label`, held to the
 * endpoint's daily limit, and tried once.
 */
async function hear(
  db: Db,
  providers: Providers,
  t: Transcriber,
  bytes: Uint8Array<ArrayBuffer>,
  format: SampleFormat,
  label: string,
  signal: AbortSignal,
): Promise<Transcript> {
  // what it is priced by: how long it plays, read from the file, and 0 s when it cannot be
  const seconds = await parseBuffer(
    bytes,
    { mimeType: SAMPLE_MIME[format], size: bytes.byteLength },
    { duration: true, skipCovers: true },
  ).then(
    (m) => m.format.duration ?? 0,
    () => 0,
  );
  const cost = (seconds / 60) * t.perMinute;
  assertWithinBudget(db, null, {
    kind: "transcription",
    cost,
    requests: [{ endpoint: t.id, cost }],
    request: "this transcript",
  });
  const money = dispatch(db, {
    kind: "transcription",
    endpoint: t,
    work: { bookId: null, chapterUid: null, label },
    hold: cost,
  });
  const provider = providers.transcription ?? endpointTranscriber();
  try {
    const heard = await provider.transcribe(
      {
        audio: new Blob([bytes], { type: SAMPLE_MIME[format] }),
        name: NAMES[format],
        seconds,
        words: false,
        signal,
        sent: money.sent,
      },
      { ...transcriberTarget(db, t), maxRetries: 0 },
    );
    return heard;
  } finally {
    money.release();
  }
}
