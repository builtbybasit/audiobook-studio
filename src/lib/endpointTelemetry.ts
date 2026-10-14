// Which fields of a speech endpoint are telemetry rather than configuration. One list read by the
// page, the server and the demo seed, so a new field cannot be forgotten on one side.
import type { Endpoint } from "@/types";

/**
 * The server stores none of these: it answers with them empty (rate limits and cooldown from
 * `live`) and ignores them in a write.
 */
export const ENDPOINT_TELEMETRY = [
  "history",
  "failures",
  "rateLimits",
  "backoffUntil",
  "lastError",
  "fetching",
] as const;
export type EndpointTelemetry = (typeof ENDPOINT_TELEMETRY)[number];

export type StoredEndpoint = Omit<Endpoint, EndpointTelemetry>;
