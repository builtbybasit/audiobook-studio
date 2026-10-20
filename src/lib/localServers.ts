// Local servers are keyed by the endpoint's row id, so a speech endpoint and a profile sharing an
// id stay apart (`server/db/rows/endpoints.ts`).
import type { EndpointKind } from "@/types";

export const serverKey = (kind: EndpointKind, id: string): string =>
  kind === "tts" ? id : `${kind}:${id}`;

export const DEFAULT_READY_SEC = 300;

/**
 * The page can't know the server's OS, so both spellings pass: `/home/me`, `C:\servers`,
 * `C:/servers`, `\\host\share`. Empty means the user's home folder.
 */
export const isFolder = (dir: string): boolean =>
  dir === "" || /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(dir);
