// Which parts of a speech endpoint are its configuration, and which are a record of its requests.
//
// The page, the server's tables and the demo's seed all have to draw that line in the same place:
// the page sends an endpoint without its telemetry, the server stores and validates what is left,
// and the demo keeps the telemetry beside the world to replay it. One list, read by all three, so
// a field added to one side cannot be forgotten on another.
import type { Endpoint } from "@/types";

/**
 * The parts of an endpoint that are a record of its requests rather than its configuration. The
 * server stores none of them: it answers with them empty and ignores them in a write. The rate
 * limits and the cooldown are filled in from what its process has seen (`live`) instead.
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

/** An endpoint as it is stored: its configuration, without the telemetry. */
export type StoredEndpoint = Omit<Endpoint, EndpointTelemetry>;
