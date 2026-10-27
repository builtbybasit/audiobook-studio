// How alike every cloned voice sounds to the rest of the library (`GET /api/endpoints/voices/likeness`).
// One report for every endpoint. The server's first call fetches a speaker model and can take
// minutes, so it is read only where `enabled` says a page has voices to compare.
import { toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { endpointSettingsService } from "@/services/endpointSettings";

export function useVoiceLikeness(enabled: MaybeRefOrGetter<boolean>) {
  return useQuery({
    key: keys.voiceLikeness,
    enabled: () => toValue(enabled),
    query: () => endpointSettingsService().voiceLikeness(),
  });
}
