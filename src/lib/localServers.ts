// Local servers are keyed by the endpoint's row id, so a speech endpoint and a profile sharing an
// id stay apart (`server/db/rows/endpoints.ts`).
import type { EndpointKind } from "@/types";

export const serverKey = (kind: EndpointKind, id: string): string =>
  kind === "tts" ? id : `${kind}:${id}`;

export const DEFAULT_READY_SEC = 300;
