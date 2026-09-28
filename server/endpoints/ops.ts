// The endpoints, as the Endpoints page saves them: the whole configuration at once.
//
// Speech endpoints, scripting profiles and the credential registry are one screen's worth of
// settings, edited in place and saved together, so a save is a replacement rather than a patch —
// the page sends what it holds and the server keeps exactly that. What is checked here is what the
// tables cannot hold or would hold wrongly: two endpoints of one kind under one id (a speech
// endpoint and a scripting profile may share one — the seeded world's `openai` is both), two
// voices or tags under one id on one endpoint, and an endpoint pointing at a credential that is
// not in the registry being saved with it.
import type { Credential } from "@/lib/credentials";
import { encodingOf, VOICE_SAMPLE } from "@/lib/endpointShapes";
import type { Db } from "~/db/client";
import {
  readEndpoint,
  readProfiles,
  readEndpointConfig,
  replaceEndpoints,
  type EndpointConfig,
} from "~/db/endpoints";
import { reconcileClones } from "~/db/voiceSamples";
import { AppError, badRequest, notFound } from "~/lib/errors";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { ProviderError } from "~/providers/http";
import type { RenderedClip } from "~/providers/speech";
import { scriptTarget, speechTarget, type ProbeResult, type Providers } from "~/providers/target";
import { endpointVoiceLister, type VoicePage, type VoiceQuery } from "~/providers/voices";
import { settleSpeech } from "~/usage/ledger";
import type { VoiceFiles } from "~/voices/files";
import { removeDropped } from "~/voices/ops";

/** What the page reads: the configuration as saved, or none on a server nobody has saved to. */
export function endpointSettings(db: Db): EndpointConfig {
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
  const all = [...config.endpoints, ...config.profiles];
  for (const [kind, list] of [
    ["speech endpoints", config.endpoints],
    ["scripting profiles", config.profiles],
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
  for (const p of config.profiles) {
    const owned: [string, string[]][] = [
      ["rate window", (p.pricing?.windows ?? []).map((w) => w.id)],
      ["promotion", (p.pricing?.promotions ?? []).map((x) => x.id)],
    ];
    for (const [what, ids] of owned) {
      const id = repeated(ids);
      if (id) throw badRequest(`“${p.name || p.id}” has two of one ${what}`, `${what}: ${id}`);
    }
  }
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
  db: Db,
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
  return endpointSettings(db);
}

/**
 * Ask a saved endpoint one small question with its saved key, through the provider the server was
 * started with — so under the fakes a test says so rather than pretending a request went out, and
 * under `endpoints` it is the request a real run would make. What is tested is what is saved: an
 * edit on the page is not the endpoint until it is.
 */
export async function testEndpoint(
  db: Db,
  providers: Providers,
  kind: "tts" | "scripting",
  id: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  if (kind === "tts") {
    const ep = readEndpoint(db, id);
    if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
    const probe = providers.speech.probe;
    if (!probe) return untestable(providers.speech.name);
    return probe.call(providers.speech, speechTarget(db, ep), signal);
  }
  const profile = readProfiles(db).find((p) => p.id === id);
  if (!profile) throw notFound("There is no saved scripting profile by that id", `id: ${id}`);
  const probe = providers.scripting.probe;
  if (!probe) return untestable(providers.scripting.name);
  return probe.call(providers.scripting, scriptTarget(db, profile), signal);
}

const untestable = (name: string): ProbeResult => ({
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
 * Always of the real endpoint, whichever provider the server was started with: the fakes are there
 * so nothing is spent by accident, and a list of voices costs nothing and changes nothing — while a
 * list the fakes made up would be voices no real request could use. The answer is only shown;
 * putting a voice on the endpoint is the page's own whole-configuration save.
 */
export async function listVoices(
  db: Db,
  providers: Providers,
  id: string,
  query: VoiceQuery,
  signal: AbortSignal,
): Promise<VoicePage> {
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
 * One voice of a saved speech endpoint saying the sample sentence (`VOICE_SAMPLE`), asked for with
 * its saved key.
 *
 * Always of the real endpoint, like `listVoices` and for the opposite reason: a sample is not free,
 * but it is a click that asks to hear this voice, and a tone from the fakes would not be it. It is
 * asked for the way a line of narration is — the endpoint's format and sample rate — so what is
 * heard is what a chapter would sound like, and the request is priced into the ledger against the
 * endpoint with no book. One attempt, like a connection test: a failure says so at once.
 */
export async function sampleVoice(
  db: Db,
  providers: Providers,
  id: string,
  voiceId: string,
  signal: AbortSignal,
): Promise<RenderedClip> {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  const voice = ep.voices.find((v) => v.id === voiceId);
  const speaker = voice?.label || voiceId;
  const provider = providers.samples ?? endpointSpeechProvider();
  try {
    return await provider.speak({
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
      sent: (request) =>
        settleSpeech(
          db,
          ep,
          {
            bookId: null,
            chapterUid: null,
            label: `Voice sample · ${speaker}`,
            voiceRef: `${ep.id}/${voiceId}`,
          },
          request,
        ),
    });
  } catch (e) {
    throw e instanceof ProviderError ? providerFailure(e) : e;
  }
}
