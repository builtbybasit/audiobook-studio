// Where a real provider sends a request: the stored endpoint or profile, with its key.
//
// Built by the job at the moment of dispatch — the base URL and model from the configuration the
// run was queued with, the key read fresh from `endpoints.api_key` — and handed to the provider,
// which is the only thing that ever puts the key on the wire. A target is never stored and never
// logged whole: `apiKey` is on the logger's redaction list, but the rule is not to spread one into
// a log record in the first place.
import type { Endpoint, EndpointOps, Profile } from "@/types";
import { OPS_DEFAULTS } from "@/lib/endpointShapes";
import type { Db, Tx } from "~/db/client";
import { readEndpointKey } from "~/db/endpoints";
import type { ScriptTarget, ScriptingProvider } from "~/providers/scripting";
import type { SpeechProvider } from "~/providers/speech";
import type { VoiceCloner } from "~/providers/clone";
import type { VoiceLister } from "~/providers/voices";

/** The pair a server is started with: what scripting and narration send their work to. */
export interface Providers {
  scripting: ScriptingProvider;
  speech: SpeechProvider;
  /**
   * Where the Voices tab's lists come from. Not chosen by `SPEECH_PROVIDER` like the pair above:
   * listing voices spends nothing, so the real lister is the default everywhere and only a test
   * hands over another.
   */
  voices?: VoiceLister;
  /**
   * What renders the Voices tab's samples. Not chosen by `SPEECH_PROVIDER` either: a sample is a
   * click on one voice that asks to hear the real thing, and the fake's tone would answer a
   * question nobody asked. So the real provider is the default, the request is priced into the
   * ledger like any other, and only a test hands over another.
   */
  samples?: SpeechProvider;
  /**
   * What makes a voice from recordings on the Voices tab. Real by default, like the two above: it
   * is a click that asks for exactly this, and only a test hands over another.
   */
  cloner?: VoiceCloner;
}

export interface ProviderTarget {
  /** the endpoint's or profile's own id, as the page names it */
  id: string;
  /** what the Endpoints page calls it, for messages */
  name: string;
  /** the base URL as configured, e.g. `https://api.fish.audio/v1`; no trailing path */
  baseUrl: string;
  model: string;
  /** null when none is kept; a provider whose endpoint `needsKey` refuses without one */
  apiKey: string | null;
  needsKey: boolean;
  /** per-request wall clock and retries after the first, with the page's defaults filled in */
  timeoutSec: EndpointOps["timeoutSec"];
  maxRetries: EndpointOps["maxRetries"];
  /** how long to hold off after a 429 that names no Retry-After */
  cooldownSec: EndpointOps["cooldownSec"];
}

/** What a connection test found. `ok: false` is an answer, not an error: the route reports it. */
export interface ProbeResult {
  ok: boolean;
  /** one sentence a person reads, e.g. "Answered in 840 ms with 2 lines" or "401: key refused" */
  message: string;
  /** how long the request took, in milliseconds; 0 when none was made */
  ms: number;
}

/** A speech endpoint as a request needs it, its key read now and its unset ops defaulted. */
export function speechTarget(db: Db | Tx, e: Endpoint): ProviderTarget {
  return targetOf(e, "tts", readEndpointKey(db, "tts", e.id));
}

/** A scripting profile as a request needs it — the one the run was queued with — and its key now. */
export function scriptTarget(db: Db | Tx, p: Profile): ScriptTarget {
  return {
    ...targetOf(p, "scripting", readEndpointKey(db, "scripting", p.id)),
    maxOutputTokens: p.maxOutputTokens,
  };
}

function targetOf(
  e: Endpoint | Profile,
  kind: "tts" | "scripting",
  apiKey: string | null,
): ProviderTarget {
  const d = OPS_DEFAULTS[kind];
  return {
    id: e.id,
    name: e.name,
    baseUrl: e.baseUrl.trim().replace(/\/+$/, ""),
    model: e.model,
    apiKey,
    needsKey: e.needsKey,
    timeoutSec: e.timeoutSec ?? d.timeoutSec,
    maxRetries: e.maxRetries ?? d.maxRetries,
    cooldownSec: e.cooldownSec ?? d.cooldownSec,
  };
}
