// The Endpoints page's configuration, saved whole (a replacement, not a patch), plus tests, voice
// lists and samples. `check` refuses what the tables can't hold: duplicate ids within a kind (a
// speech endpoint and a profile may share one), unknown credentials, bad prompts.
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
import { encodingOf, SAMPLE_LINES, VOICE_SAMPLE } from "@/lib/endpointShapes";
import type { Db, Tx } from "~/db/client";
import {
  readEndpoint,
  readProfiles,
  readEndpointConfig,
  readTranscriber,
  replaceEndpoints,
  writeSpeedRange,
  type EndpointConfig,
} from "~/db/endpoints";
import { PROFILE_KEY, TRANSCRIBER_KEY } from "~/db/rows/endpoints";
import { readLibraryPrompt } from "~/db/settings";
import { reconcileClones } from "~/db/voiceSamples";
import { inBackground, warnIfFails } from "~/lib/background";
import { AppError, badRequest, notFound } from "~/lib/errors";
import { refusePrompt } from "~/lib/schemas";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { ProviderError } from "~/providers/http";
import { SAMPLE_HEAD_BYTES, SAMPLE_MIME, sniffSample, type SampleFormat } from "~/providers/clone";
import {
  scriptTarget,
  speechTarget,
  transcriberTarget,
  type ProviderTarget,
  type Providers,
} from "~/providers/target";
import type { Launchable } from "~/servers/localServers";
import { endpointTranscriber, type Transcript } from "~/providers/transcription";
import { endpointVoiceLister, type VoiceQuery } from "~/providers/voices";
import { assertWithinBudget } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";
import { parseBuffer } from "music-metadata";
import type { VoiceFiles } from "~/voices/files";
import { removeDropped } from "~/voices/ops";

export function endpointSettings(db: Db | Tx): EndpointConfig {
  return readEndpointConfig(db);
}

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
  const chosen = config.script?.profile;
  if (chosen != null && !config.profiles.some((p) => p.id === chosen))
    throw badRequest(
      "The scripting settings choose a profile that is not in the list",
      `profile: ${chosen}`,
    );
}

/**
 * Replace the stored configuration, all or nothing. Rendered clips are left alone; the Narration
 * page's drift rule spots the ones a changed tag or rate reaches.
 */
export function saveEndpoints(
  db: Db | Tx,
  config: EndpointConfig,
  voiceFiles: VoiceFiles,
): EndpointConfig {
  check(config);
  // Clone recordings are reconciled in the same transaction; a removed voice takes its recordings
  // once the removal outlives its Undo.
  const gone = db.transaction((tx) => {
    replaceEndpoints(tx, config);
    return reconcileClones(tx, config, Date.now());
  });
  removeDropped(voiceFiles, gone);
  inBackground(
    voiceFiles.heard.keepOnly(config.endpoints.map((e) => e.id)),
    "voice samples of removed endpoints left on disk",
  );
  return endpointSettings(db);
}

/** Probe a saved endpoint (not unsaved edits) through the same provider a real run uses. */
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
    const speech = providers.speech;
    if (!speech.probe) return untestable(speech.name);
    return speech.probe(speechTarget(db, ep), signal);
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
  const scripting = providers.scripting;
  if (!scripting.probe) return untestable(scripting.name);
  const { system, user } = resolvePrompt({
    library: readLibraryPrompt(db),
    profile: profile.prompt,
  });
  return scripting.probe(scriptTarget(db, profile), signal, {
    template: { system, user },
    notes: profile.prompt?.notes ?? "",
  });
}

function savedTarget(db: Db | Tx, key: string): ProviderTarget | undefined {
  if (key.startsWith(PROFILE_KEY)) {
    const p = readProfiles(db).find((p) => p.id === key.slice(PROFILE_KEY.length));
    return p && scriptTarget(db, p);
  }
  if (key.startsWith(TRANSCRIBER_KEY)) {
    const t = readTranscriber(db, key.slice(TRANSCRIBER_KEY.length));
    return t && transcriberTarget(db, t);
  }
  const e = readEndpoint(db, key);
  return e && speechTarget(db, e);
}

/** The saved endpoint (never a draft) a local server's `serverKey` names, ready to start. */
export function launchTarget(db: Db | Tx, key: string): Launchable {
  const target = savedTarget(db, key);
  // the key check also catches `transcription:` alone, which reads as the first one switched on
  if (!target?.localServer || target.localServer.key !== key)
    throw notFound("No saved endpoint by that key starts a local server", `key: ${key}`);
  return { name: target.name, baseUrl: target.baseUrl, localServer: target.localServer };
}

const untestable = (name: string): EndpointProbe => ({
  ok: false,
  message: `${name} has no connection test`,
  ms: 0,
});

/**
 * A provider failure as an HTTP error: `400` when retrying unchanged won't help (refused before
 * sending, or a 4xx other than 408/429), else `502`. The message never carries the key.
 */
export function providerFailure(e: ProviderError): AppError {
  const refusedHere = e.status === 0 && !e.retryable;
  const refusedThere = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
  return new AppError(refusedHere || refusedThere ? 400 : 502, e.message);
}

/** The voices a saved speech endpoint offers; listing is free, so it always asks the endpoint. */
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
 * What a speech endpoint's server says it takes: batch limits and speed. Asked afresh every time and
 * whether or not batches are on, so the page can show what turning them on would do. The speed is
 * kept on the endpoint (`speedRange`).
 */
export async function batchLimits(
  db: Db,
  providers: Providers,
  id: string,
  signal: AbortSignal,
): Promise<EndpointBatches> {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const speech = providers.speech;
  if (!speech.capabilities) return { limits: null, speed: null };
  try {
    const answer = await speech.capabilities(speechTarget(db, ep), signal, true);
    writeSpeedRange(db, id, answer.speed);
    return answer;
  } catch (e) {
    throw e instanceof ProviderError ? providerFailure(e) : e;
  }
}

export interface VoiceSampleAudio {
  bytes: Uint8Array;
  mime: string;
  /** seconds, when known */
  duration: number | null;
  source: "recording" | "rendered";
  /** served from disk, without asking the provider */
  kept: boolean;
}

/** The cache key for a provider's own recording; the same whatever the endpoint's settings. */
const RECORDING = "recording";

/** The cache key for a rendered sample: everything that changes how it sounds. */
const renderedAs = (ep: Endpoint, text: string): string =>
  JSON.stringify(["rendered", ep.baseUrl, ep.model, encodingOf(ep), ep.sampleRate ?? null, text]);

/** What stays kept beside a new clip: the recording and every built-in line as it sounds now. */
const stillHeard = (ep: Endpoint): string[] => [
  RECORDING,
  ...SAMPLE_LINES.map((t) => renderedAs(ep, t)),
];

/**
 * A voice's demo audio, cheapest first: the copy kept on disk, the provider's own free recording
 * (Fish keeps one), else `text` rendered in the endpoint's format, billed once and kept. Only the
 * default line plays the recording. Simulated samples are never kept. One attempt, so a failure
 * shows at once.
 */
export async function sampleVoice(
  db: Db,
  providers: Providers,
  files: VoiceFiles,
  id: string,
  voiceId: string,
  signal: AbortSignal,
  text = VOICE_SAMPLE,
): Promise<VoiceSampleAudio> {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const simulated = isSimulated(ep.baseUrl);
  const rendered = renderedAs(ep, text);
  const asDefault = text === VOICE_SAMPLE;
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
    const kept = await files.heard.read(
      ep.id,
      voiceId,
      asDefault ? [RECORDING, rendered] : [rendered],
    );
    if (kept) return heard(kept.bytes, kept.format, kept.made, true);
    const recording = asDefault ? await ownRecording(db, providers, ep, voiceId, signal) : null;
    if (recording) {
      await files.heard.keep(
        ep.id,
        voiceId,
        RECORDING,
        recording.bytes,
        recording.format,
        stillHeard(ep),
      );
      return heard(recording.bytes, recording.format, RECORDING, false);
    }
  }

  const voice = ep.voices.find((v) => v.id === voiceId);
  const speaker = voice?.label || voiceId;
  const provider = providers.samples ?? endpointSpeechProvider();
  // billed like a line of narration, so held to the endpoint's daily limit
  const cost = sampleWorstCase(ep, text);
  assertWithinBudget(db, null, {
    kind: "narration",
    cost,
    requests: [{ endpoint: ep.id, cost }],
    request: "this voice sample",
  });
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
      text,
      speaker,
      type: "narration",
      direction: "",
      instructions: "",
      voiceRef: `${ep.id}/${voiceId}`,
      sampleRate: ep.sampleRate ?? null,
      speed: null,
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
  // kept before answering, so the next press finds it; a failure to keep only logs
  if (!simulated)
    await warnIfFails(
      files.heard.keep(ep.id, voiceId, rendered, clip.bytes, clip.format, stillHeard(ep)),
      "voice sample not kept",
      { id, voiceId },
    );
  return heard(clip.bytes, clip.format, rendered, false, clip.duration);
}

function sampleWorstCase(ep: Endpoint, text: string): number {
  const billing = billingOf(ep);
  const units = measureSpeech(
    { text, audioSeconds: text.length / AUDIO_CHARS_PER_SECOND },
    billing,
  );
  return worstCaseOf(estimateSpeech(billing, readPricing(ep), units, Date.now()));
}

/** The provider's own recording, or null on any failure: rendering the sample reports errors. */
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

/** The filename a recording is sent to the transcriber under. */
const NAMES: Record<SampleFormat, string> = {
  wav: "sample.wav",
  mp3: "sample.mp3",
  m4a: "sample.m4a",
  opus: "sample.ogg",
  flac: "sample.flac",
};

/** Transcribe a clone sample with the named transcription endpoint, or the first switched on. */
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

/** “The quick brown fox jumps over the lazy dog.”, 16 kHz mono WAV, 3.4 s. */
const TEST_SAMPLE = new URL("./test-sample.wav", import.meta.url);

/** Transcribe once with no book, held to the endpoint's daily limit and priced under `label`. */
async function hear(
  db: Db,
  providers: Providers,
  t: Transcriber,
  bytes: Uint8Array<ArrayBuffer>,
  format: SampleFormat,
  label: string,
  signal: AbortSignal,
): Promise<Transcript> {
  // priced by duration read from the file; 0 s when unreadable
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
