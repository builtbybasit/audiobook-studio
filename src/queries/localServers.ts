// The local servers the app starts and the GPUs (`GET /endpoints/servers`), polled while a reader
// is mounted: servers start, crash and stop on their own. Start and Stop answer the same way, so
// the answer goes straight into the cache.
import { defineQuery, useMutation, useQuery, useQueryCache } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { endpointSettingsService, type LocalServers } from "@/services/endpointSettings";
import { useEndpointsStore } from "@/stores/endpoints";
import { toastFailure } from "@/stores/toastFailure";

export const SERVERS_POLL_MS = 2000;

export const useLocalServers = defineQuery(() =>
  useQuery({
    key: keys.localServers,
    query: () => endpointSettingsService().servers(),
    staleTime: SERVERS_POLL_MS,
    autoRefetch: SERVERS_POLL_MS,
  }),
);

/** Start and Stop by `serverKey`. Start sends the saved config, so unsent edits go first. */
export function useLocalServerActions() {
  const queryCache = useQueryCache();
  const install = (answer: LocalServers) => queryCache.setQueryData(keys.localServers, answer);
  const start = useMutation({
    mutation: async (key: string) => {
      await useEndpointsStore().flushWrites();
      return endpointSettingsService().startServer(key);
    },
    onSuccess: install,
    onError: (cause) => toastFailure("start the server", cause),
  });
  const stop = useMutation({
    mutation: (key: string) => endpointSettingsService().stopServer(key),
    onSuccess: install,
    onError: (cause) => toastFailure("stop the server", cause),
  });
  return { start, stop };
}
