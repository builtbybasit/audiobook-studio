// Where a real provider sends a request: the endpoint or profile with its key, built at dispatch
// and read fresh from `endpoints.api_key`. Never stored, and never spread into a log record.
import type {
  Endpoint,
  EndpointKind,
  EndpointOps,
  Profile,
  SpeechServer,
  Transcriber,
} from "@/types";
import { OPS_DEFAULTS } from "@/lib/endpointShapes";
import { isSimulated } from "@/lib/providers";
import { cliOf } from "@/lib/providers/cli";
import type { Db, Tx } from "~/db/client";
import { readEndpointKey } from "~/db/endpoints";
import type { ScriptTarget, ScriptingProvider } from "~/providers/scripting";
import type { SpeechProvider } from "~/providers/speech";
import type { TranscriptionProvider, TranscriptionTarget } from "~/providers/transcription";
import type { VoiceCloner } from "~/providers/clone";
import type { VoiceLister } from "~/providers/voices";

/** What the server sends work to. The optional ones default to the real ones; tests swap them. */
export interface Providers {
  scripting: ScriptingProvider;
  speech: SpeechProvider;
  voices?: VoiceLister;
  /** renders the Voices tab's samples, priced into the ledger like any other request */
  samples?: SpeechProvider;
  cloner?: VoiceCloner;
  transcription?: TranscriptionProvider;
}

export interface ProviderTarget {
  id: string;
  /** for messages */
  name: string;
  /** e.g. `https://api.fish.audio/v1`; no trailing slash */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  needsKey: boolean;
  /** defaults filled in */
  timeoutSec: EndpointOps["timeoutSec"];
  maxRetries: EndpointOps["maxRetries"];
  /** the hold-off after a 429 that names no Retry-After */
  cooldownSec: EndpointOps["cooldownSec"];
  /** speech only: for a base URL that cannot say which server it is (`Endpoint.server`) */
  server?: SpeechServer | null;
  /** only for a simulated target (`isSimulated(baseUrl)`) */
  simulation?: Simulation;
}

export interface Simulation {
  latencyMs: number;
  /** 0 to 1 */
  failRate: number;
}

export function speechTarget(db: Db | Tx, e: Endpoint): ProviderTarget {
  return {
    ...targetOf(e, "tts", readEndpointKey(db, "tts", e.id)),
    ...(e.server ? { server: e.server } : {}),
  };
}

export function scriptTarget(db: Db | Tx, p: Profile): ScriptTarget {
  return {
    ...targetOf(p, "scripting", readEndpointKey(db, "scripting", p.id)),
    maxOutputTokens: p.maxOutputTokens,
    reasoning: p.reasoning ?? null,
  };
}

export function transcriberTarget(db: Db | Tx, t: Transcriber): TranscriptionTarget {
  return {
    ...targetOf(t, "transcription", readEndpointKey(db, "transcription", t.id)),
    ...(t.hotwordLambda != null ? { hotwordLambda: t.hotwordLambda } : {}),
    ...(t.resample16k === false ? { resample16k: false } : {}),
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
    // simulated targets and CLIs never need a key, whatever was saved
    needsKey: e.needsKey && !isSimulated(e.baseUrl) && !cliOf(e.baseUrl),
    timeoutSec: e.timeoutSec ?? d.timeoutSec,
    maxRetries: e.maxRetries ?? d.maxRetries,
    cooldownSec: e.cooldownSec ?? d.cooldownSec,
    ...(isSimulated(e.baseUrl) && {
      simulation: {
        // a profile has no latency: a tenth of its chunk estimate, the browser demo's pace
        latencyMs: Math.max(
          0,
          ("latency" in e ? e.latency : "secPerChunk" in e ? e.secPerChunk * 100 : 0) || 0,
        ),
        failRate: "failRate" in e ? Math.min(1, Math.max(0, e.failRate || 0)) : 0,
      },
    }),
  };
}
