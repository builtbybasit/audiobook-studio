// Where a real provider sends a request: the stored endpoint or profile, with its key.
//
// Built by the job at the moment of dispatch — the base URL and model from the configuration the
// run was queued with, the key read fresh from `endpoints.api_key` — and handed to the provider,
// which is the only thing that ever puts the key on the wire. A target is never stored and never
// logged whole: `apiKey` is on the logger's redaction list, but the rule is not to spread one into
// a log record in the first place.
import type { Endpoint, EndpointKind, EndpointOps, Profile, Transcriber } from "@/types";
import { OPS_DEFAULTS } from "@/lib/endpointShapes";
import { isSimulated } from "@/lib/providers";
import type { Db, Tx } from "~/db/client";
import { readEndpointKey } from "~/db/endpoints";
import type { ScriptTarget, ScriptingProvider } from "~/providers/scripting";
import type { SpeechProvider } from "~/providers/speech";
import type { TranscriptionProvider, TranscriptionTarget } from "~/providers/transcription";
import type { VoiceCloner } from "~/providers/clone";
import type { VoiceLister } from "~/providers/voices";

/** The pair a server is started with: what scripting and narration send their work to. */
export interface Providers {
  scripting: ScriptingProvider;
  speech: SpeechProvider;
  /**
   * Where the Voices tab's lists come from. Listing voices spends nothing, so the endpoints' own
   * lister is the default everywhere and only a test hands over another.
   */
  voices?: VoiceLister;
  /**
   * What renders the Voices tab's samples: the endpoints' own provider unless a test hands over
   * another, so a sample is the endpoint's voice — a tone for a simulated one — and its request is
   * priced into the ledger like any other.
   */
  samples?: SpeechProvider;
  /**
   * What makes a voice from recordings on the Voices tab. Real by default, like the two above: it
   * is a click that asks for exactly this, and only a test hands over another.
   */
  cloner?: VoiceCloner;
  /**
   * What hears a clone sample, or a rendered line, back as words. The transcription endpoints' own
   * by default; only a test hands over another.
   */
  transcription?: TranscriptionProvider;
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
  /**
   * For a simulated endpoint or profile (`isSimulated(baseUrl)`), how it behaves in place of a
   * server: how long each answer takes and how often one fails. Absent for every other target.
   */
  simulation?: Simulation;
}

/** How a simulated target behaves: what the endpoint's `latency` and `failRate` say. */
export interface Simulation {
  /** how long each answer takes, in milliseconds */
  latencyMs: number;
  /** the share of requests that fail, 0 to 1 */
  failRate: number;
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
    reasoning: p.reasoning ?? null,
  };
}

/** A transcription endpoint as a request needs it, and its key now. */
export function transcriberTarget(db: Db | Tx, t: Transcriber): TranscriptionTarget {
  return {
    ...targetOf(t, "transcription", readEndpointKey(db, "transcription", t.id)),
    ...(t.hotwordLambda != null ? { hotwordLambda: t.hotwordLambda } : {}),
  };
}

function targetOf(
  e: Endpoint | Profile | Transcriber,
  kind: EndpointKind,
  apiKey: string | null,
): ProviderTarget {
  const d = OPS_DEFAULTS[kind];
  return {
    id: e.id,
    name: e.name,
    baseUrl: e.baseUrl.trim().replace(/\/+$/, ""),
    model: e.model,
    apiKey,
    // a simulated one is answered here, so a key it was saved as needing would only refuse it
    needsKey: e.needsKey && !isSimulated(e.baseUrl),
    timeoutSec: e.timeoutSec ?? d.timeoutSec,
    maxRetries: e.maxRetries ?? d.maxRetries,
    cooldownSec: e.cooldownSec ?? d.cooldownSec,
    ...(isSimulated(e.baseUrl) && {
      simulation: {
        // a profile has no latency of its own: it answers in a tenth of the time it estimates a
        // chunk takes, the pace the browser's demo scripts at
        latencyMs: Math.max(
          0,
          ("latency" in e ? e.latency : "secPerChunk" in e ? e.secPerChunk * 100 : 0) || 0,
        ),
        failRate: "failRate" in e ? Math.min(1, Math.max(0, e.failRate || 0)) : 0,
      },
    }),
  };
}
