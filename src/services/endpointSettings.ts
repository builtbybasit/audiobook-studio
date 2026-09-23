// Where the endpoints are configured: the speech endpoints, the scripting profiles, and the named
// credentials they point at.
//
// The same arrangement as `@/services/library`: one HTTP implementation, chosen at startup, and
// `null` in demo mode — where the configuration is the seeded one the endpoints store holds. This
// is not `EndpointService` next door, which answers for the *past* requests the Endpoints page
// charts; this is the configuration a narration job on the server reads to know what to call.
//
// The whole configuration travels as one document. The page binds its fields straight onto the
// objects it edits, so there is no single action to hang a narrower request on — and the server
// has to check the three lists against each other anyway (a credential an endpoint names must be
// in the same body), which a partial write could not let it do.
import type { Credential } from "@/lib/credentials";
import { keyring } from "@/lib/keyring";
import type { Endpoint, EndpointKind, Profile } from "@/types";
import { HttpClient, type FetchLike } from "@/services/http";
import { isBackend } from "@/services/mode";

/**
 * The parts of an endpoint that are this browser's record of its requests rather than its
 * configuration. The server keeps none of them: it answers with them empty and ignores them in a
 * write.
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

/** What is sent: the whole configuration, replacing what the server holds. */
export interface EndpointConfig {
  endpoints: StoredEndpoint[];
  profiles: Profile[];
  credentials: Credential[];
}

/**
 * The configuration as the server holds it. Endpoints come back with their telemetry empty — the
 * request history is this browser's, not something the server keeps. `saved` is false only while
 * nobody has ever written a configuration to this server, and the lists are empty then.
 */
export interface EndpointSettings extends EndpointConfig {
  endpoints: Endpoint[];
  saved: boolean;
}

/** What the server found when it sent one small real request to a saved endpoint. `ok: false` is
 *  an answer — a refused key, a wrong model — not a failed request. */
export interface EndpointProbe {
  ok: boolean;
  /** one sentence to show as it is */
  message: string;
  /** how long the request took; 0 when none was made */
  ms: number;
}

export interface EndpointSettingsService {
  getSettings(): Promise<EndpointSettings>;
  /**
   * Replace the whole configuration. Refused whole when any part of it does not hold together.
   *
   * An entry's `apiKey` is the one write-only field: left out, the server keeps the key it holds;
   * `""` forgets it. The store puts it on exactly one entry, and only when a key was typed.
   */
  putSettings(body: EndpointConfig): Promise<EndpointSettings>;
  /** Test the *saved* endpoint, with the key the server holds for it. */
  testEndpoint(kind: EndpointKind, id: string): Promise<EndpointProbe>;
}

export class HttpEndpointSettingsService implements EndpointSettingsService {
  private readonly http: HttpClient;
  constructor(base = "/api", fetch?: FetchLike) {
    this.http = new HttpClient(base, fetch);
  }

  getSettings(): Promise<EndpointSettings> {
    return this.http.get<EndpointSettings>("/endpoints");
  }

  putSettings(body: EndpointConfig): Promise<EndpointSettings> {
    return this.http.put<EndpointSettings>("/endpoints", body);
  }

  testEndpoint(kind: EndpointKind, id: string): Promise<EndpointProbe> {
    return this.http.post<EndpointProbe>("/endpoints/test", { kind, id });
  }
}

let service: EndpointSettingsService | null = null;

/** The endpoint settings service, or `null` when the configuration is the seeded one in the store. */
export function activeEndpointSettingsService(): EndpointSettingsService | null {
  if (service) return service;
  return isBackend ? (service = new HttpEndpointSettingsService()) : null;
}

/** For tests and for wiring at startup. Set it before the endpoints store loads. */
export function setEndpointSettingsService(next: EndpointSettingsService | null): void {
  service = next;
}

/**
 * Whether the key an endpoint or profile needs is in place, for every "no key" warning and gate.
 *
 * With a server answering, the key is the server's and the browser only ever learns that one is
 * held (`hasKey`); the keyring is the demo's, and whatever it holds is sent nowhere. Asking the
 * keyring there would clear a warning for a key the server has never seen. `slot` is the keyring
 * slot — the endpoint's id, or `profile:<id>`.
 */
export function keyInPlace(entry: { hasKey?: boolean } | null | undefined, slot: string): boolean {
  return activeEndpointSettingsService() ? !!entry?.hasKey : keyring.has(slot);
}
