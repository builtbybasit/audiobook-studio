// Simulated voice discovery. Most OpenAI-compatible servers (Kokoro-FastAPI, Orpheus…) expose
// GET /audio/voices; Fish Audio instead has a per-account model catalogue at the host root, which
// is authenticated and returns far more than voices, so it is mapped down to the few fields a voice
// picker needs.
//
// Only the transport is here. The toast that reports it belongs to the store.
import { keyring } from "@/lib/keyring";
import { fishModelsUrl, isFishAudio, voicesFromFishModels } from "@/lib/endpoints";
import { DISCOVERABLE_VOICES, FISH_MODELS } from "../fixtures/voices";
import type { Endpoint } from "@/types";

/** Where the request would go — the same URL the failure messages quote back. */
export const voicesUrl = (ep: Endpoint): string =>
  isFishAudio(ep) ? fishModelsUrl(ep.baseUrl) : `${ep.baseUrl}/audio/voices`;

/** Resolves with the number of voices added; rejects the way a failed fetch would. */
export function discoverVoices(ep: Endpoint): Promise<number> {
  ep.fetching = true;
  const fish = isFishAudio(ep);
  const url = voicesUrl(ep);
  return new Promise<number>((res, rej) =>
    setTimeout(() => {
      ep.fetching = false;
      if (!/^https?:\/\/.+\..+/.test(ep.baseUrl) && !/127\.0\.0\.1|localhost/.test(ep.baseUrl))
        return rej(new Error(`GET ${url} — could not connect`));
      // the catalogue is the account's own library, so it is never readable anonymously
      if (fish && !keyring.has(ep.id)) return rej(new Error(`GET ${url} — 401 Unauthorized`));
      const found = fish ? voicesFromFishModels(FISH_MODELS) : DISCOVERABLE_VOICES;
      const added = found
        .filter((v) => !ep.voices.some((x) => x.id === v.id))
        .map((v) => ({ ...v }));
      ep.voices.push(...added);
      res(added.length);
    }, 1200),
  );
}
