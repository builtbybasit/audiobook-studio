// What an endpoint is on the wire: the paths each kind is reached at, the operational defaults a
// request falls back on, and where Fish Audio differs from everyone else.
//
// Split out of `endpoints.ts` because the server calls these providers too, and that file reaches
// for the browser's keyring. Nothing here imports Vue or holds state, so both sides share one copy
// of the rules instead of the server keeping a second that drifts.
import type { Endpoint, EndpointKind, EndpointOps } from "@/types";

export const OPS_DEFAULTS: Record<EndpointKind, EndpointOps> = {
  scripting: {
    timeoutSec: 120,
    maxRetries: 3,
    cooldownSec: 10,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
  },
  tts: {
    timeoutSec: 60,
    maxRetries: 2,
    cooldownSec: 8,
    spendLimit: null,
    credentialId: null,
    quotaGroup: null,
  },
};

/** What each kind appends to the base URL — worth showing, since the two differ. */
export const KIND_PATH: Record<EndpointKind, string> = {
  scripting: "/chat/completions",
  tts: "/audio/speech",
};

/** Fish Audio takes the model in a header and the voice as `reference_id`, so the path everything
 *  else uses does not apply. Kept here so the Connection tab can show the right request line. */
export const isFishAudio = (e: Pick<Endpoint, "baseUrl">): boolean =>
  /(^|\/\/)([a-z0-9-]+\.)*fish\.audio(\/|$)/i.test(e.baseUrl);

export function ttsRequestPath(e: Pick<Endpoint, "baseUrl">): string {
  return isFishAudio(e) ? "/tts" : KIND_PATH.tts;
}

/** Fish Audio serves speech under /v1 but its model catalogue at the host root, so the voice list
 *  cannot just be appended to the base URL the way an OpenAI-compatible /audio/voices can. */
export function fishModelsUrl(baseUrl: string): string {
  return (
    baseUrl
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/v\d+$/, "") + "/model?self=true&page_size=100"
  );
}
