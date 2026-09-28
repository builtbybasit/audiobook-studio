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
import { CLONE_CONSENT } from "@/lib/endpointShapes";
import type {
  ClonedVoice,
  Endpoint,
  EndpointKind,
  FoundVoice,
  KeptVoiceSamples,
  Profile,
} from "@/types";
import { HttpClient, seg, type FetchLike } from "@/services/http";
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
 * request history is this browser's, not something the server keeps. A server nobody has saved to
 * answers with empty lists.
 */
export interface EndpointSettings extends EndpointConfig {
  endpoints: Endpoint[];
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

/** Which of a speech endpoint's catalogues to read. Only Fish Audio has a public one. */
export interface VoiceListQuery {
  /** `library`: every voice the account holds; `public`: one page of a search */
  source: "library" | "public";
  /** words in a voice's title, or a Fish voice id to find that one voice */
  query?: string;
  /** a language code the voices must speak, e.g. `en` */
  language?: string;
  /** 1-based */
  page?: number;
}

/** A page of voices the server found. Nothing is added to the endpoint until the page adds it. */
export interface VoiceListPage {
  /** a public Fish voice carries Fish's own recording of it, when it has one */
  voices: FoundVoice[];
  /** how many the provider says match */
  total: number;
  page: number;
  hasMore: boolean;
}

/** One voice saying the server's sample sentence: the audio as the endpoint answered, and its length. */
export interface VoiceSample {
  blob: Blob;
  /** seconds */
  duration: number;
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
  /** Ask the *saved* speech endpoint, with the key the server holds, what voices it offers. */
  listVoices(id: string, query: VoiceListQuery): Promise<VoiceListPage>;
  /** Have the *saved* speech endpoint say a sentence in one voice. A real, priced request. */
  sampleVoice(id: string, voice: string): Promise<VoiceSample>;
  /**
   * Make a voice from recordings on the *saved* endpoint's provider, with the key the server holds.
   * `consent` must be true: it says the person has the right to clone the voice in them. The server
   * keeps the recordings with the voice, and says whether it managed to.
   */
  cloneVoice(id: string, request: VoiceCloneRequest): Promise<ClonedVoice>;
  /** Every voice of the *saved* endpoint whose recordings are kept. */
  keptSamples(id: string): Promise<KeptVoiceSamples[]>;
  /**
   * Keep recordings for a voice already on the *saved* endpoint, in place of any it had — for a
   * voice cloned before recordings were kept. Nothing is sent to the provider.
   */
  keepSamples(
    id: string,
    voice: string,
    request: Omit<VoiceCloneRequest, "title">,
  ): Promise<KeptVoiceSamples>;
  /** Forget one voice's kept recordings; the voice stays. */
  forgetSamples(id: string, voice: string): Promise<void>;
  /** Take back a forget no save has made final yet; answers with the recordings. */
  restoreSamples(id: string, voice: string): Promise<KeptVoiceSamples>;
}

/** What a voice is made from: a name, the recordings, and the person's say-so. */
export interface VoiceCloneRequest {
  title: string;
  clips: File[];
  consent: boolean;
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

  listVoices(id: string, query: VoiceListQuery): Promise<VoiceListPage> {
    return this.http.post<VoiceListPage>("/endpoints/voices", { id, ...query });
  }

  cloneVoice(id: string, request: VoiceCloneRequest): Promise<ClonedVoice> {
    const form = recordingsForm(request);
    form.set("id", id);
    form.set("title", request.title.trim());
    return this.http.postFormData<ClonedVoice>("/endpoints/voices/clone", form);
  }

  keptSamples(id: string): Promise<KeptVoiceSamples[]> {
    return this.http.get<KeptVoiceSamples[]>(`/endpoints/${seg(id)}/samples`);
  }

  keepSamples(
    id: string,
    voice: string,
    request: Omit<VoiceCloneRequest, "title">,
  ): Promise<KeptVoiceSamples> {
    return this.http.postFormData<KeptVoiceSamples>(
      samplesPath(id, voice),
      recordingsForm(request),
    );
  }

  async forgetSamples(id: string, voice: string): Promise<void> {
    await this.http.delete<null>(samplesPath(id, voice));
  }

  restoreSamples(id: string, voice: string): Promise<KeptVoiceSamples> {
    return this.http.post<KeptVoiceSamples>(`${samplesPath(id, voice)}/restore`);
  }

  async sampleVoice(id: string, voice: string): Promise<VoiceSample> {
    const { blob, headers } = await this.http.postForFile("/endpoints/sample", { id, voice });
    return { blob, duration: Number(headers.get("x-audio-duration")) || 0 };
  }
}

const samplesPath = (id: string, voice: string) =>
  `/endpoints/${seg(id)}/voices/${seg(voice)}/samples`;

/**
 * The recordings and the person's say-so, as the server reads them. The sentence sent is the one
 * the form shows beside the box, so what the server keeps is what was actually agreed to.
 */
function recordingsForm(request: Omit<VoiceCloneRequest, "title">): FormData {
  const form = new FormData();
  if (request.consent) {
    form.set("consent", "yes");
    form.set("consentText", CLONE_CONSENT);
  }
  for (const clip of request.clips) form.append("clips", clip, clip.name);
  return form;
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
