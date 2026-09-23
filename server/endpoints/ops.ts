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
import type { Db } from "~/db/client";
import {
  endpointsSaved,
  readEndpoint,
  readProfiles,
  readEndpointConfig,
  replaceEndpoints,
  type EndpointConfig,
} from "~/db/endpoints";
import { AppError, badRequest, notFound } from "~/lib/errors";
import { ProviderError } from "~/providers/http";
import { scriptTarget, speechTarget, type ProbeResult, type Providers } from "~/providers/target";
import { endpointVoiceLister, type VoicePage, type VoiceQuery } from "~/providers/voices";

/** What the page reads: the configuration, and whether it was ever saved here. */
export interface EndpointSettingsAnswer extends EndpointConfig {
  saved: boolean;
}

export function endpointSettings(db: Db): EndpointSettingsAnswer {
  return { ...readEndpointConfig(db), saved: endpointsSaved(db) };
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
export function saveEndpoints(db: Db, config: EndpointConfig): EndpointSettingsAnswer {
  check(config);
  db.transaction((tx) => replaceEndpoints(tx, config));
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
    if (!(e instanceof ProviderError)) throw e;
    // Refused before any request — no key, nothing to search — is the request's to fix; anything
    // the provider answered, or failed to, is the provider's.
    throw new AppError(e.status === 0 && !e.retryable ? 400 : 502, e.message);
  }
}
